import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../../lib/auth';
import { encryptCredential } from '../../../../../lib/binance-credentials';
import { isApprovedAdminDemoStagingTarget } from '../../../../../lib/admin-demo-staging-policy';
import { pool, query } from '../../../../../lib/db';
import { validCsrf } from '../../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('saveCredentials'),
    apiKey: z.string().trim().min(8).max(256),
    apiSecret: z.string().trim().min(8).max(512),
    confirmDemoIssued: z.literal(true),
  }).strict(),
  z.object({ action: z.literal('revokeCredentials') }).strict(),
]);

async function getAccountStatus(adminUserId: number) {
  const [accounts, sessions, events] = await Promise.all([
    query<{
      owner_confirmed_at: string;
      created_at: string;
      updated_at: string;
      revoked_at: string | null;
    }>(
      `SELECT owner_confirmed_at, created_at, updated_at, revoked_at
         FROM public.admin_binance_demo_test_accounts
        WHERE admin_user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'`,
      [adminUserId],
    ),
    query<{
      id: string;
      session_status: string;
      symbol: string | null;
      direction: string | null;
      created_at: string;
      started_at: string | null;
      ended_at: string | null;
    }>(
      `SELECT id::TEXT, session_status, symbol, direction, created_at, started_at, ended_at
         FROM public.admin_demo_test_sessions
        WHERE admin_user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'
        ORDER BY created_at DESC LIMIT 25`,
      [adminUserId],
    ),
    query<{
      event_type: string;
      created_at: string;
    }>(
      `SELECT event_type, created_at
         FROM public.admin_demo_test_account_events
        WHERE admin_user_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [adminUserId],
    ),
  ]);
  const account = accounts.rows[0];
  return {
    exchange: 'BINANCE',
    environment: 'DEMO',
    credentialStatus: {
      configured: Boolean(account && !account.revoked_at),
      ownerConfirmed: Boolean(account && !account.revoked_at && account.owner_confirmed_at),
      createdAt: account?.created_at ?? null,
      updatedAt: account?.updated_at ?? null,
      revokedAt: account?.revoked_at ?? null,
    },
    sessions: sessions.rows,
    credentialEvents: events.rows,
    remoteLifecycle: 'BLOCKED',
  } as const;
}

export async function GET() {
  if (!isApprovedAdminDemoStagingTarget(process.env)) {
    return Response.json(
      { error: 'Admin Binance Demo testing is available only for the approved Staging target.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const admin = await requireAdmin();
    const data = await getAccountStatus(admin.id);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof AuthError ? error.message : 'Admin Binance Demo status is unavailable. The isolated test schema may require an approved Staging migration.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  if (!isApprovedAdminDemoStagingTarget(process.env)) {
    return Response.json(
      { error: 'Admin Binance Demo testing is available only for the approved Staging target.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const admin = await requireAdmin();
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'Invalid Admin Binance Demo credential request.' }, { status: 422 });

    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('smart_exit_admin_demo_credentials:' || $1::TEXT))",
        [admin.id],
      );
      const activeSessions = await client.query<{ id: string }>(
        `SELECT id::TEXT
           FROM public.admin_demo_test_sessions
          WHERE admin_user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'
            AND session_status NOT IN ('PASSED', 'FAILED', 'REVOKED', 'EXPIRED')
          LIMIT 1`,
        [admin.id],
      );
      if (activeSessions.rows[0]) {
        await client.query('ROLLBACK');
        return Response.json(
          { error: 'Admin Binance Demo credentials cannot be changed while a test session is active or awaiting reconciliation.' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }

      if (parsed.data.action === 'saveCredentials') {
        const apiKey = parsed.data.apiKey.trim();
        const apiSecret = parsed.data.apiSecret.trim();
        const saved = await client.query<{ account_id: string }>(
          `WITH saved_account AS (
             INSERT INTO public.admin_binance_demo_test_accounts (
               admin_user_id, exchange, environment, api_key_ciphertext, api_secret_ciphertext,
               api_key_suffix, owner_confirmed_at, revoked_at, updated_at
             ) VALUES ($1, 'BINANCE', 'DEMO', $2, $3, $4, NOW(), NULL, NOW())
             ON CONFLICT (admin_user_id, exchange, environment) DO UPDATE SET
               api_key_ciphertext = EXCLUDED.api_key_ciphertext,
               api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
               api_key_suffix = EXCLUDED.api_key_suffix,
               owner_confirmed_at = NOW(),
               revoked_at = NULL,
               updated_at = NOW()
             RETURNING id, admin_user_id
           )
           INSERT INTO public.admin_demo_test_account_events (account_id, admin_user_id, event_type, safe_details)
           SELECT id, admin_user_id, 'CREDENTIALS_SAVED',
                  '{"exchange":"BINANCE","environment":"DEMO","ownerConfirmed":true}'::JSONB
             FROM saved_account
           RETURNING account_id::TEXT`,
          [admin.id, encryptCredential(apiKey), encryptCredential(apiSecret), apiKey.slice(-4)],
        );
        if (!saved.rows[0]) throw new Error('Credential update was not recorded.');
      } else {
        await client.query(
          `WITH revoked_account AS (
             UPDATE public.admin_binance_demo_test_accounts
                SET revoked_at = NOW(), api_key_ciphertext = NULL,
                    api_secret_ciphertext = NULL, api_key_suffix = NULL, updated_at = NOW()
              WHERE admin_user_id = $1 AND exchange = 'BINANCE' AND environment = 'DEMO'
                AND revoked_at IS NULL
              RETURNING id, admin_user_id
           )
           INSERT INTO public.admin_demo_test_account_events (account_id, admin_user_id, event_type, safe_details)
           SELECT id, admin_user_id, 'CREDENTIALS_REVOKED',
                  '{"exchange":"BINANCE","environment":"DEMO"}'::JSONB
             FROM revoked_account`,
          [admin.id],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return Response.json(
      { data: await getAccountStatus(admin.id) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof AuthError ? error.message : 'Admin Binance Demo credential update failed. No exchange request was made.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
