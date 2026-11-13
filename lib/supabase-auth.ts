import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient, User as SupabaseUser } from '@supabase/supabase-js';
import type { NextRequest, NextResponse } from 'next/server';

type AuthEnvironment = Record<string, string | undefined>;
type CookieWrite = { name: string; value: string; options?: CookieOptions };

export function getSupabaseAuthConfig(env: AuthEnvironment = process.env) {
  const urlValue = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!urlValue || !anonKey) {
    throw new Error('Supabase Auth requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be a valid origin.');
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must be a credential-free HTTPS origin.');
  }

  return { url: url.origin, anonKey };
}

function deploymentOrigin(env: AuthEnvironment): string {
  const deploymentHost = env.VERCEL_ENV === 'preview'
    ? env.VERCEL_URL?.trim()
    : env.VERCEL_ENV === 'production'
      ? env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
      : '';
  const configuredOrigin = env.APP_URL?.trim();
  const value = deploymentHost
    ? (deploymentHost.startsWith('http') ? deploymentHost : `https://${deploymentHost}`)
    : configuredOrigin || 'http://localhost:3000';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The configured authentication origin is invalid.');
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('The authentication origin must be a credential-free HTTPS origin.');
  }

  if (env.VERCEL_ENV === 'preview') {
    const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!deploymentHost || (productionHost && url.host.toLowerCase() === productionHost.toLowerCase())) {
      throw new Error('Preview authentication callbacks must use a distinct Vercel Preview origin.');
    }
  }
  if (env.VERCEL_ENV === 'production' && !deploymentHost) {
    throw new Error('Production authentication callbacks require VERCEL_PROJECT_PRODUCTION_URL.');
  }

  return url.origin;
}

export function getAuthCallbackUrl(flow: 'signup' | 'recovery', env: AuthEnvironment = process.env) {
  const callback = new URL('/auth/callback', deploymentOrigin(env));
  callback.searchParams.set('flow', flow);
  return callback.toString();
}

export function hasSupabaseAuthCookie(cookiesToCheck: { getAll(): { name: string }[] }) {
  return cookiesToCheck.getAll().some(({ name }) => /^sb-.+-auth-token(?:\.\d+)?$/.test(name));
}

export function isVerifiedSupabaseIdentity(
  identity: Pick<SupabaseUser, 'email' | 'email_confirmed_at'>,
) {
  return Boolean(identity.email?.trim() && identity.email_confirmed_at);
}

export function createSupabaseRequestClient(request: NextRequest) {
  const config = getSupabaseAuthConfig();
  const pendingCookies: CookieWrite[] = [];
  const client = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const cookie of cookiesToSet) {
          request.cookies.set(cookie.name, cookie.value);
          pendingCookies.push(cookie);
        }
      },
    },
  });

  return {
    client,
    applyCookies<T extends NextResponse>(response: T) {
      for (const { name, value, options } of pendingCookies) {
        response.cookies.set(name, value, options ?? {});
      }
      return response;
    },
  };
}

export type { SupabaseClient, SupabaseUser };
