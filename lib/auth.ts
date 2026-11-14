import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { query } from './db';

const SESSION_COOKIE = 'ethcryptohub_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 14;

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

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO public.auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))`,
    [userId, sha256(token), SESSION_MAX_AGE],
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query('DELETE FROM public.auth_sessions WHERE token_hash = $1', [sha256(token)]);
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const result = await query<User>(
    `SELECT u.id, u.email, u.full_name, u.country_code, u.phone_number, u.x_handle,
            u.is_x_verified, u.is_email_verified, u.is_active, u.role
       FROM public.auth_sessions s
       JOIN public.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()
        AND u.is_active = 1 AND u.is_email_verified = 1
      LIMIT 1`,
    [sha256(token)],
  );
  return result.rows[0] ?? null;
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
