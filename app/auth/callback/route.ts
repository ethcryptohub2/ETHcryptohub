import { NextRequest, NextResponse } from 'next/server';
import { assertSupabaseAuthSchemaReady, linkVerifiedSupabaseIdentity } from '../../../lib/auth';
import { query } from '../../../lib/db';
import { createSupabaseRequestClient } from '../../../lib/supabase-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const flow = request.nextUrl.searchParams.get('flow');
  const code = request.nextUrl.searchParams.get('code');
  if ((flow !== 'signup' && flow !== 'recovery') || !code) {
    return NextResponse.redirect(new URL('/login?authError=confirmation_failed', request.url));
  }

  await assertSupabaseAuthSchemaReady();
  const { client, applyCookies } = createSupabaseRequestClient(request);
  const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    if (!exchangeError.status || exchangeError.status >= 500) {
      throw new Error('Supabase Auth could not exchange the confirmation code.');
    }
    return applyCookies(NextResponse.redirect(new URL('/login?authError=confirmation_failed', request.url)));
  }

  const { data, error: userError } = await client.auth.getUser();
  if (userError && (!userError.status || userError.status >= 500)) {
    throw new Error('Supabase Auth could not validate the confirmation session.');
  }
  if (userError || !data.user?.email_confirmed_at) {
    const signedOut = await client.auth.signOut({ scope: 'local' });
    if (signedOut.error) throw new Error('Unverified Supabase Auth session could not be cleared.');
    return applyCookies(NextResponse.redirect(new URL('/login?authError=confirmation_failed', request.url)));
  }

  if (flow === 'signup') {
    const profile = await linkVerifiedSupabaseIdentity(data.user);
    if (!profile) {
      const signedOut = await client.auth.signOut({ scope: 'local' });
      if (signedOut.error) throw new Error('Unlinked Supabase Auth session could not be cleared.');
      return applyCookies(NextResponse.redirect(new URL('/login?authError=account_unavailable', request.url)));
    }
    await query('UPDATE public.users SET last_login = NOW() WHERE id = $1', [profile.id]);
  }

  const destination = flow === 'recovery' ? '/reset-password' : '/dashboard';
  return applyCookies(NextResponse.redirect(new URL(destination, request.url)));
}
