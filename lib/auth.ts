import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { query } from './db';
import { createSupabaseServerClient } from './supabase-auth-server';
import {
  hasSupabaseAuthCookie,
  isVerifiedSupabaseIdentity,
  type SupabaseUser,
} from './supabase-auth';

export interface User {
  id: number;
  email: string;
  full_name: string | null;
  country_code: string;
  phone_number: string | null;
  x_handle: string | null;
  is_x_verified: number;
  is_email_verified: number;
  is_active: number;
  role: 'user' | 'admin';
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function profileMetadata(identity: SupabaseUser) {
  const metadata = identity.user_metadata ?? {};
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name.trim().slice(0, 150) : '';
  const countryCode = ['+91', '+1', '+44', '+971'].includes(String(metadata.country_code))
    ? String(metadata.country_code)
    : '+91';
  const phoneNumber = typeof metadata.phone_number === 'string' && /^[0-9]{10}$/.test(metadata.phone_number)
    ? metadata.phone_number
    : '';
  return { fullName, countryCode, phoneNumber };
}

export async function createPendingAuthProfile(input: {
  email: string;
  fullName: string;
  countryCode: string;
  phoneNumber: string;
}) {
  await query(
    `INSERT INTO public.users (email, password_hash, full_name, country_code, phone_number, is_email_verified)
     VALUES ($1, NULL, NULLIF($2, ''), $3, NULLIF($4, ''), 0)
     ON CONFLICT (email) DO NOTHING`,
    [input.email.toLowerCase(), input.fullName, input.countryCode, input.phoneNumber],
  );
}

export async function assertSupabaseAuthSchemaReady() {
  const result = await query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('password_hash', 'supabase_user_id')`,
  );
  const columns = new Map(result.rows.map((row) => [row.column_name, row.is_nullable]));
  if (columns.get('password_hash') !== 'YES' || !columns.has('supabase_user_id')) {
    throw new Error('Apply the Supabase Auth identity-link migration before enabling authentication.');
  }
}

export async function linkVerifiedSupabaseIdentity(identity: SupabaseUser): Promise<User | null> {
  const email = identity.email?.trim().toLowerCase();
  if (!email || !isVerifiedSupabaseIdentity(identity)) return null;

  const linked = await query<User>(
    `SELECT id, email, full_name, country_code, phone_number, x_handle,
            is_x_verified, is_email_verified, is_active, role
       FROM public.users
      WHERE supabase_user_id = $1
      LIMIT 1`,
    [identity.id],
  );
  if (linked.rows[0]) {
    const user = linked.rows[0];
    return user.is_active === 1 && user.is_email_verified === 1 ? user : null;
  }

  const profile = profileMetadata(identity);
  const result = await query<User>(
    `INSERT INTO public.users (
       email, password_hash, full_name, country_code, phone_number,
       is_email_verified, supabase_user_id
     ) VALUES ($1, NULL, NULLIF($2, ''), $3, NULLIF($4, ''), 1, $5)
     ON CONFLICT (email) DO UPDATE SET
       supabase_user_id = EXCLUDED.supabase_user_id,
       is_email_verified = 1
     WHERE public.users.is_active = 1
       AND (public.users.supabase_user_id IS NULL OR public.users.supabase_user_id = EXCLUDED.supabase_user_id)
     RETURNING id, email, full_name, country_code, phone_number, x_handle,
               is_x_verified, is_email_verified, is_active, role`,
    [email, profile.fullName, profile.countryCode, profile.phoneNumber, identity.id],
  );
  return result.rows[0] ?? null;
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  if (!hasSupabaseAuthCookie(jar)) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (error.status && error.status < 500) return null;
    throw new Error('Supabase Auth could not validate the current session.');
  }
  return data.user ? linkVerifiedSupabaseIdentity(data.user) : null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AuthError(401, 'Sign in is required.');
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== 'admin') throw new AuthError(403, 'Administrator access is required.');
  return user;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function hashValue(value: string) {
  return sha256(value);
}

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
