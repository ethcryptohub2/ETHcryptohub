import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, z } from 'zod';
import {
  assertSupabaseAuthSchemaReady,
  createPendingAuthProfile,
  linkVerifiedSupabaseIdentity,
} from './auth';
import { query } from './db';
import {
  createSupabaseRequestClient,
  getAuthCallbackUrl,
  hasSupabaseAuthCookie,
} from './supabase-auth';
import { guardedPost, jsonError } from './http';

const emailSchema = z.string().trim().email().max(255);
const signupSchema = z.object({
  email: emailSchema,
  password: z.string().min(8).max(72),
  fullName: z.string().trim().max(150).default(''),
  countryCode: z.enum(['+91', '+1', '+44', '+971']).default('+91'),
  phoneNumber: z.string().regex(/^(|[0-9]{10})$/),
});

function requiredAuthSecret() {
  const secret = process.env.AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('AUTH_SECRET must contain at least 32 characters.');
  return secret;
}

function authFailureStatus(error: { status?: number }, clientErrorStatus: number) {
  if (!error.status || error.status >= 500) return 503;
  return error.status === 429 ? 429 : clientErrorStatus;
}

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

async function updateLastLogin(userId: number) {
  await query('UPDATE public.users SET last_login = NOW() WHERE id = $1', [userId]);
}

export async function authRoute(action: string, request: NextRequest) {
  if (action === 'me' && !hasSupabaseAuthCookie(request.cookies)) {
    return NextResponse.json({ data: null }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let applyCookies: (response: NextResponse) => NextResponse = (response) => response;
  try {
    const routeClient = createSupabaseRequestClient(request);
    applyCookies = routeClient.applyCookies;
    const { client } = routeClient;

    if (action === 'signup') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const body = signupSchema.parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`signup:${peer}`, 10, 3600))) {
        return applyCookies(jsonError('Too many signup attempts. Try again later.', 429));
      }
      if (Buffer.byteLength(body.password, 'utf8') > 72) {
        return applyCookies(jsonError('Password must be 72 bytes or fewer.', 422));
      }
      await assertSupabaseAuthSchemaReady();

      const { data, error } = await client.auth.signUp({
        email: body.email.toLowerCase(),
        password: body.password,
        options: {
          data: {
            full_name: body.fullName,
            country_code: body.countryCode,
            phone_number: body.phoneNumber,
          },
          emailRedirectTo: getAuthCallbackUrl('signup'),
        },
      });
      if (error) {
        return applyCookies(jsonError(
          'Account registration could not be completed.',
          authFailureStatus(error, 422),
        ));
      }
      if (!data.user) {
        throw new Error('Supabase Auth returned no user after registration.');
      }
      if (data.user.identities?.length) {
        await createPendingAuthProfile({
          email: body.email,
          fullName: body.fullName,
          countryCode: body.countryCode,
          phoneNumber: body.phoneNumber,
        });
      }
      if (data.session && data.user.email_confirmed_at) {
        const profile = await linkVerifiedSupabaseIdentity(data.user);
        if (!profile) {
          const signedOut = await client.auth.signOut({ scope: 'local' });
          if (signedOut.error) throw new Error('The unlinked Supabase Auth session could not be cleared.');
          return applyCookies(jsonError('A verified email and active profile are required.', 403));
        }
        await updateLastLogin(profile.id);
        return applyCookies(NextResponse.json({ data: { signedIn: true } }));
      }
      return applyCookies(NextResponse.json({
        data: { verificationRequired: true },
      }, { status: 201, headers: { 'Cache-Control': 'no-store' } }));
    }

    if (action === 'login') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const body = z.object({ email: emailSchema, password: z.string().min(1).max(72) })
        .parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`login:${peer}`, 20, 900))) {
        return applyCookies(jsonError('Too many sign-in attempts. Try again later.', 429));
      }
      await assertSupabaseAuthSchemaReady();
      const { data, error } = await client.auth.signInWithPassword({
        email: body.email.toLowerCase(),
        password: body.password,
      });
      if (error) {
        return applyCookies(jsonError('Email or password is incorrect.', authFailureStatus(error, 401)));
      }
      if (!data.user) {
        throw new Error('Supabase Auth returned no user after sign-in.');
      }
      if (!data.user.email_confirmed_at) {
        const signedOut = await client.auth.signOut({ scope: 'local' });
        if (signedOut.error) throw new Error('The unverified Supabase Auth session could not be cleared.');
        return applyCookies(NextResponse.json(
          { error: 'Confirm your email before signing in.', code: 'EMAIL_NOT_VERIFIED' },
          { status: 403, headers: { 'Cache-Control': 'no-store' } },
        ));
      }
      const profile = await linkVerifiedSupabaseIdentity(data.user);
      if (!profile) {
        const signedOut = await client.auth.signOut({ scope: 'local' });
        if (signedOut.error) throw new Error('The unlinked Supabase Auth session could not be cleared.');
        return applyCookies(jsonError('This account is unavailable. Contact support.', 403));
      }
      await updateLastLogin(profile.id);
      return applyCookies(NextResponse.json({ data: { signedIn: true } }));
    }

    if (action === 'resend') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const body = z.object({ email: emailSchema }).parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`resend:${peer}`, 10, 600)) ||
          !(await consumeRateLimit(`resend-email:${body.email.toLowerCase()}`, 3, 600))) {
        return applyCookies(NextResponse.json(
          { error: 'Too many verification requests. Please wait before trying again.' },
          { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '600' } },
        ));
      }
      await assertSupabaseAuthSchemaReady();
      const { error } = await client.auth.resend({
        type: 'signup',
        email: body.email.toLowerCase(),
        options: { emailRedirectTo: getAuthCallbackUrl('signup') },
      });
      if (error) {
        return applyCookies(jsonError(
          'Verification email could not be sent.',
          authFailureStatus(error, 503),
        ));
      }
      return applyCookies(NextResponse.json({
        data: { notice: 'If this address needs confirmation, an email will be sent.' },
      }, { headers: { 'Cache-Control': 'no-store' } }));
    }

    if (action === 'recovery') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const body = z.object({ email: emailSchema }).parse(await request.json());
      const peer = request.headers.get('x-vercel-forwarded-for') ?? 'unknown';
      if (!(await consumeRateLimit(`recovery:${peer}`, 10, 600)) ||
          !(await consumeRateLimit(`recovery-email:${body.email.toLowerCase()}`, 3, 600))) {
        return applyCookies(NextResponse.json(
          { error: 'Too many recovery requests. Please wait before trying again.' },
          { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '600' } },
        ));
      }
      await assertSupabaseAuthSchemaReady();
      const { error } = await client.auth.resetPasswordForEmail(body.email.toLowerCase(), {
        redirectTo: getAuthCallbackUrl('recovery'),
      });
      if (error) {
        return applyCookies(jsonError(
          'Password recovery could not be requested.',
          authFailureStatus(error, 503),
        ));
      }
      return applyCookies(NextResponse.json({
        data: { notice: 'If an account exists for this address, recovery instructions will be sent.' },
      }, { headers: { 'Cache-Control': 'no-store' } }));
    }

    if (action === 'update-password') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const body = z.object({
        password: z.string().min(8).max(72),
        confirmation: z.string().min(8).max(72),
      }).parse(await request.json());
      if (Buffer.byteLength(body.password, 'utf8') > 72 || body.password !== body.confirmation) {
        return applyCookies(jsonError('Passwords must match and be 72 bytes or fewer.', 422));
      }
      await assertSupabaseAuthSchemaReady();
      const { data: userData, error: userError } = await client.auth.getUser();
      if (userError && (!userError.status || userError.status >= 500)) {
        throw new Error('Supabase Auth could not validate the recovery session.');
      }
      if (userError || !userData.user?.email_confirmed_at) {
        return applyCookies(jsonError('A verified recovery session is required.', 401));
      }
      const { error } = await client.auth.updateUser({ password: body.password });
      if (error) {
        return applyCookies(jsonError('Password could not be updated.', authFailureStatus(error, 422)));
      }
      return applyCookies(NextResponse.json({ data: { passwordUpdated: true } }));
    }

    if (action === 'logout') {
      const blocked = guardedPost(request);
      if (blocked) return applyCookies(blocked);
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw new Error('Supabase Auth sign-out failed.');
      return applyCookies(NextResponse.json({ data: { signedOut: true } }));
    }

    if (action === 'me') {
      const { data, error } = await client.auth.getUser();
      if (error && (!error.status || error.status >= 500)) {
        throw new Error('Supabase Auth could not validate the current session.');
      }
      const user = data.user ? await linkVerifiedSupabaseIdentity(data.user) : null;
      return applyCookies(NextResponse.json({ data: user }, { headers: { 'Cache-Control': 'no-store' } }));
    }

    const response = jsonError('Not found.', 404);
    return applyCookies(response);
  } catch (error) {
    if (error instanceof ZodError) return applyCookies(jsonError('Please check the submitted information.', 422));
    console.error('Authentication route failed:', error instanceof Error ? error.name : 'UnknownError');
    return applyCookies(jsonError('Authentication is temporarily unavailable.', 503));
  }
}
