import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { query } from './db';
import { isApprovedAdminDemoStagingTarget } from './admin-demo-staging-policy';
import {
  AdminDemoSchemaNotReadyError,
  createPersistentAdminDemoAuthorizationRepository,
  type AdminDemoAuthorization,
  type AdminDemoAuthorizationContext,
} from './admin-demo-authorization';

function isMissingDemoSchemaError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['42P01', '42703'].includes(String(error.code));
}

export async function createServerAdminDemoAuthorizationRepository() {
  if (!isApprovedAdminDemoStagingTarget(process.env)) {
    throw new AdminDemoSchemaNotReadyError();
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new AdminDemoSchemaNotReadyError();
  }

  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(url);
  } catch (error) {
    if (isMissingDemoSchemaError(error)) throw new AdminDemoSchemaNotReadyError();
    throw new Error('Admin Demo authorization state is unavailable.');
  }
  if (
    !['https:', 'http:'].includes(supabaseUrl.protocol) ||
    (supabaseUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(supabaseUrl.hostname))
  ) {
    throw new AdminDemoSchemaNotReadyError();
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const authorizationReader = {
    async getAuthorization(context: AdminDemoAuthorizationContext): Promise<AdminDemoAuthorization | null> {
      try {
        const result = await query<{
          id: string;
          admin_user_id: number;
          session_id: string;
          test_account_id: string;
          exchange: string;
          environment: string;
          authorization_status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
          permitted_actions: string[];
          expires_at: string;
          consumed_at: string | null;
        }>(
          `SELECT a.id::TEXT, a.admin_user_id, a.session_id::TEXT, s.test_account_id::TEXT,
                  a.exchange, a.environment,
                  CASE
                    WHEN a.revoked_at IS NOT NULL THEN 'REVOKED'
                    WHEN a.expires_at <= NOW() THEN 'EXPIRED'
                    ELSE 'ACTIVE'
                  END AS authorization_status,
                  a.permitted_actions, a.expires_at, a.consumed_at
             FROM public.admin_demo_test_authorizations a
             JOIN public.admin_demo_test_sessions s
               ON s.id = a.session_id AND s.admin_user_id = a.admin_user_id
            WHERE a.id = $1 AND a.session_id = $2 AND a.admin_user_id = $3
              AND s.test_account_id = $4
            LIMIT 1`,
          [context.authorizationId, context.sessionId, context.adminUserId, context.testAccountId],
        );
        const row = result.rows[0];
        if (!row) return null;
        return {
          id: row.id,
          adminUserId: row.admin_user_id,
          sessionId: row.session_id,
          testAccountId: row.test_account_id,
          exchange: row.exchange,
          environment: row.environment,
          status: row.authorization_status,
          permittedActions: row.permitted_actions,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
        };
      } catch {
        throw new AdminDemoSchemaNotReadyError();
      }
    },
  };

  return createPersistentAdminDemoAuthorizationRepository(
    {
      async rpc(functionName, parameters) {
        const result = await client.rpc(functionName, parameters);
        return { data: result.data, error: result.error ? { code: result.error.code } : null };
      },
    },
    authorizationReader,
  );
}
