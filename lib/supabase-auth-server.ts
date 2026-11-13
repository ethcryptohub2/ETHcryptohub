import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabaseAuthConfig } from './supabase-auth';

export async function createSupabaseServerClient() {
  const config = getSupabaseAuthConfig();
  const cookieStore = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        if (cookiesToSet.length) {
          throw new Error('Supabase session cookies must be refreshed in the request proxy or an API route.');
        }
      },
    },
  });
}
