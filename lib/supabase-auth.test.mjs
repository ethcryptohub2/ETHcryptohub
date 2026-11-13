import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAuthCallbackUrl,
  getSupabaseAuthConfig,
  hasSupabaseAuthCookie,
  isVerifiedSupabaseIdentity,
} from './supabase-auth.ts';

test('Supabase Auth configuration requires a credential-free HTTPS origin and public key', () => {
  assert.deepEqual(getSupabaseAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://staging-project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-test-key',
  }), {
    url: 'https://staging-project.supabase.co',
    anonKey: 'public-test-key',
  });
  assert.throws(() => getSupabaseAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://staging-project.supabase.co',
  }), /requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.throws(() => getSupabaseAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://user:pass@staging-project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-test-key',
  }), /credential-free HTTPS origin/);
});

test('authentication callbacks use the exact Preview origin and never fall back to Production', () => {
  const callback = getAuthCallbackUrl('signup', {
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'cryptohub-git-feature-eth.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'cryptohub.vercel.app',
    APP_URL: 'https://cryptohub.vercel.app',
  });
  assert.equal(callback, 'https://cryptohub-git-feature-eth.vercel.app/auth/callback?flow=signup');
  assert.throws(() => getAuthCallbackUrl('recovery', {
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'cryptohub.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'cryptohub.vercel.app',
  }), /distinct Vercel Preview origin/);
});

test('Supabase identity linking requires verified email ownership', () => {
  assert.equal(isVerifiedSupabaseIdentity({ email: 'user@example.com', email_confirmed_at: null }), false);
  assert.equal(isVerifiedSupabaseIdentity({ email: ' ', email_confirmed_at: '2026-01-01T00:00:00Z' }), false);
  assert.equal(isVerifiedSupabaseIdentity({ email: 'user@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }), true);
});

test('Supabase auth cookie detection accepts only auth-token cookies and chunks', () => {
  assert.equal(hasSupabaseAuthCookie({ getAll: () => [{ name: 'sb-staging-auth-token.0' }] }), true);
  assert.equal(hasSupabaseAuthCookie({ getAll: () => [{ name: 'ethcryptohub_session' }] }), false);
});
