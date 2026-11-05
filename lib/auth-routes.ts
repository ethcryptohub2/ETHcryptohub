import { createHash, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, z } from 'zod';
import { createSession, currentUser } from './auth';
import { query } from './db';
import { EmailDeliveryError, sendVerificationCode } from './email';
import { guardedPost, jsonError } from './http';

const emailSchema = z.string().trim().email().max(255);
function requiredAuthSecret() {
  const secret = process.env.AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters.');
  return secret;
}
const signupSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(72),
  fullName: z.string().trim().max(150).default(''),
  countryCode: z.enum(['+91', '+1', '+44', '+971']).default('+91'),
  phoneNumber: z.string().regex(/^(|[0-9]{10})$/),
});

const otpHash = (userId: number, code: string) =>
  createHash('sha256').update(`${requiredAuthSecret()}:${userId}:${code}`).digest('hex');

async function consumeRateLimit(bucket: string, limit: number, windowSeconds: number) {
  const rateKey = createHash('sha256')
    .update(`${requiredAuthSecret()}:${bucket}`)
    .digest('hex');
  const result = await query<{ allowed: boolean }>(
    `INSERT INTO public.auth_rate_limits (rate_key, request_count, window_ends_at)
     VALUES ($1, 1, NOW() + ($3 * INTERVAL '1 second'))
     ON CONFLICT (rate_key) DO UPDATE SET
       request_count = CASE WHEN auth_rate_limits.window_ends_at <= NOW()
                            THEN 1 ELSE auth_rate_limits.request_count + 1 END,
       window_ends_at = CASE WHEN auth_rate_limits.window_ends_at <= NOW()
                             THEN NOW() + ($3 * INTERVAL '1 second')
                             ELSE auth_rate_limits.window_ends_at END
     RETURNING request_count <= $2 AS allowed`,
    [rateKey, limit, windowSeconds],
  );
  return result.rows[0]?.allowed === true;
}

async function issueCode(userId: number, email: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `INSERT INTO public.email_verification_codes (user_id, code_hash, expires_at, attempts, locked_until)
     VALUES ($1, $2, EXTRACT(EPOCH FROM NOW() + INTERVAL '10 minutes')::bigint, 0, NULL)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at, attempts = 0, locked_until = NULL, created_at = NOW()`,
    [userId, otpHash(userId, code)],
  );
  await sendVerificationCode(email, code);
}

export async function authRoute(action: string, request: NextRequest) {
  try {
    if (action === 'signup') {
      const blocked = guardedPost(request);
      if (blocked) return blocked;
      const body = signupSchema.parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`signup:${peer}`, 10, 3600))) return jsonError('Too many signup attempts. Try again later.', 429);
      if (Buffer.byteLength(body.password, 'utf8') > 72) return jsonError('Password must be 72 bytes or fewer.', 422);
      const passwordHash = await bcrypt.hash(body.password, 12);
      const inserted = await query<{ id: number }>(
        `INSERT INTO public.users (email, password_hash, full_name, country_code, phone_number)
         VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''))
         RETURNING id`,
        [body.email.toLowerCase(), passwordHash, body.fullName, body.countryCode, body.phoneNumber],
      );
      await issueCode(inserted.rows[0]!.id, body.email.toLowerCase());
      return NextResponse.json({ data: { verificationRequired: true } }, { status: 201 });
    }

    if (action === 'login') {
      const blocked = guardedPost(request);
      if (blocked) return blocked;
      const body = z.object({ email: emailSchema, password: z.string().min(1).max(72) }).parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`login:${peer}`, 20, 900))) return jsonError('Too many sign-in attempts. Try again later.', 429);
      const result = await query<{ id: number; password_hash: string; is_email_verified: number; is_active: number }>(
        'SELECT id, password_hash, is_email_verified, is_active FROM public.users WHERE email = $1 LIMIT 1',
        [body.email.toLowerCase()],
      );
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
        return jsonError('Email or password is incorrect.', 401);
      }
      if (Number(user.is_email_verified) !== 1) return jsonError('Verify your email before signing in.', 403);
      if (Number(user.is_active) !== 1) return jsonError('This account is currently unavailable.', 403);
      await query('UPDATE public.users SET last_login = NOW() WHERE id = $1', [user.id]);
      await createSession(user.id);
      return NextResponse.json({ data: { signedIn: true } });
    }

    if (action === 'verify') {
      const blocked = guardedPost(request);
      if (blocked) return blocked;
      const body = z.object({ email: emailSchema, code: z.string().regex(/^[0-9]{6}$/) }).parse(await request.json());
      const result = await query<{ id: number; is_email_verified: number }>(
        'SELECT id, is_email_verified FROM public.users WHERE email = $1 LIMIT 1',
        [body.email.toLowerCase()],
      );
      const user = result.rows[0];
      if (!user) return jsonError('The code is invalid, expired, or temporarily locked.', 400);
      if (Number(user.is_email_verified) === 1) return NextResponse.json({ data: { verified: true } });
      const { pool } = await import('./db');
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const codeRow = await client.query<{ code_hash: string; attempts: number; expires_at: number; locked_until: number | null }>(
          'SELECT code_hash, attempts, expires_at, locked_until FROM public.email_verification_codes WHERE user_id = $1 FOR UPDATE',
          [user.id],
        );
        const row = codeRow.rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!row || Number(row.expires_at) <= now || Number(row.attempts) >= 5 || (row.locked_until !== null && Number(row.locked_until) > now)) {
          await client.query('ROLLBACK');
          return jsonError('The code is invalid, expired, or temporarily locked.', 400);
        }
        const codeMatches = row.code_hash.startsWith('$2')
          ? await bcrypt.compare(body.code, row.code_hash)
          : row.code_hash === otpHash(user.id, body.code);
        if (!codeMatches) {
          const attempts = Number(row.attempts) + 1;
          await client.query(
            'UPDATE public.email_verification_codes SET attempts = $2, locked_until = CASE WHEN $2 >= 5 THEN $3 ELSE locked_until END WHERE user_id = $1',
            [user.id, attempts, now + 900],
          );
          await client.query('COMMIT');
          return jsonError('The code is invalid, expired, or temporarily locked.', 400);
        }
        await client.query('UPDATE public.users SET is_email_verified = 1, email_verification_token = NULL WHERE id = $1', [user.id]);
        await client.query('DELETE FROM public.email_verification_codes WHERE user_id = $1', [user.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return NextResponse.json({ data: { verified: true } });
    }

    if (action === 'resend') {
      const blocked = guardedPost(request);
      if (blocked) return blocked;
      const body = z.object({ email: emailSchema }).parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`resend:${peer}`, 10, 3600))) return jsonError('Too many resend requests. Try again later.', 429);
      if (!(await consumeRateLimit(`resend-email:${body.email.toLowerCase()}`, 3, 3600))) {
        return NextResponse.json({ data: { notice: 'If this address needs verification, a new code will be sent.' } });
      }
      const lookup = await query<{ id: number; is_email_verified: number; is_active: number }>(
        'SELECT id, is_email_verified, is_active FROM public.users WHERE email = $1 LIMIT 1',
        [body.email.toLowerCase()],
      );
      const user = lookup.rows[0];
      if (user && Number(user.is_email_verified) !== 1 && Number(user.is_active) === 1) {
        await issueCode(user.id, body.email.toLowerCase());
      }
      return NextResponse.json({ data: { notice: 'If this address needs verification, a new code will be sent.' } });
    }

    if (action === 'logout') {
      const blocked = guardedPost(request);
      if (blocked) return blocked;
      const { destroySession } = await import('./auth');
      await destroySession();
      return NextResponse.json({ data: { signedOut: true } });
    }

    if (action === 'me') {
      return NextResponse.json({ data: await currentUser() });
    }

    return jsonError('Not found.', 404);
  } catch (error) {
    if (error instanceof ZodError) return jsonError('Please check the submitted information.', 422);
    if (error instanceof EmailDeliveryError) {
      return jsonError('Account saved, but email could not be sent. Configure Resend and request another code.', 503);
    }
    if (error instanceof Error && error.message.includes('duplicate key')) return jsonError('An account with that email already exists.', 409);
    console.error('Authentication route failed:', error instanceof Error ? error.message : 'Unknown error');
    return jsonError('Authentication is temporarily unavailable.', 503);
  }
}
