import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AdminDemoRequestValidationError, type AdminDemoRouteContext, resolveProvider, withAdmin, withMutation,
} from '../../_shared';
import { isApprovedAdminDemoStagingTarget } from '../../../../../../../lib/admin-demo-staging-policy';
import { createAdminDemoProviderRepository, type AdminDemoProviderQuery } from '../../../../../../../lib/admin-demo-provider-repository';
import { isCredentialEncryptionConfigured } from '../../../../../../../lib/binance-credentials';
import { pool, query } from '../../../../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(512),
  passphrase: z.string().trim().min(1).max(256).optional(),
  ownerConfirmed: z.literal(true),
  environment: z.enum(['DEMO', 'TESTNET']),
}).strict();

function staging(request: NextRequest) {
  return process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === 'functional-staging' &&
    request.nextUrl.hostname === process.env.VERCEL_URL &&
    process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' &&
    isApprovedAdminDemoStagingTarget(process.env);
}

function approved(provider: string) {
  const sha = process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_SHA;
  const deadline = Date.parse(process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_UNTIL ?? '');
  const remaining = deadline - Date.now();
  return Boolean(sha && /^[a-f0-9]{40}$/.test(sha) && sha === process.env.VERCEL_GIT_COMMIT_SHA &&
    provider === process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_PROVIDER &&
    remaining > 0 && remaining <= 15 * 60_000);
}

function repository() {
  return createAdminDemoProviderRepository({
    query,
    async transaction(work) {
      const client = await pool().connect();
      let rollbackFailure: Error | undefined;
      try {
        await client.query('BEGIN');
        const tx: AdminDemoProviderQuery = (sql, values) => client.query(sql, values ? [...values] : []);
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch { rollbackFailure = new Error('Credential transaction rollback failed.'); }
        throw error;
      } finally {
        client.release(rollbackFailure);
      }
    },
    async rpc() { throw new Error('Credential storage has no execution authorization transport.'); },
  });
}

async function prerequisites(request: NextRequest, adminId: number) {
  if (!staging(request)) return 'OUTSIDE_STAGING';
  if (!isCredentialEncryptionConfigured()) return 'ENCRYPTION_REQUIRED';
  const schema = await query<{ installed: boolean }>(
    `SELECT count(*) = 6 AND bool_and(c.relrowsecurity) AS installed
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN (
        'admin_demo_identities', 'admin_demo_exchange_credentials', 'admin_demo_exchange_sessions',
        'admin_demo_exchange_authorizations', 'admin_demo_exchange_executions', 'admin_demo_exchange_audit_events'
      )`,
  );
  if (!schema.rows[0]?.installed) return 'SCHEMA_REQUIRED';
  const identity = await query<{ ready: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.admin_demo_identities
      WHERE admin_user_id = $1 AND admin_scope = 'ADMIN' AND is_active) AS ready`, [adminId],
  );
  return identity.rows[0]?.ready ? null : 'ADMIN_DEMO_IDENTITY_REQUIRED';
}

export async function GET(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withAdmin(async admin => {
    const scope = await resolveProvider(request, (await params).provider);
    const blocker = await prerequisites(request, admin.id);
    if (blocker) return { state: blocker, enabled: false, removalEnabled: false, configured: false, updatedAt: null };
    const status = await repository().getCredentialStatus(admin.id, scope.provider);
    const enabled = approved(scope.provider);
    return { state: enabled ? 'READY' : 'APPROVAL_REQUIRED', enabled,
      removalEnabled: enabled && process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_DELETE_APPROVED === 'true',
      configured: status.configured, updatedAt: status.updatedAt };
  });
}

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async admin => {
    const parsed = credential.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AdminDemoRequestValidationError('Enter valid dedicated Demo credentials and confirm their environment.');
    const scope = await resolveProvider(request, (await params).provider, parsed.data.environment);
    const requiresPassphrase = scope.provider === 'OKX' || scope.provider === 'BITGET';
    if (requiresPassphrase !== Boolean(parsed.data.passphrase)) {
      throw new AdminDemoRequestValidationError('The passphrase must match the selected provider requirements.');
    }
    if (await prerequisites(request, admin.id) || !approved(scope.provider)) throw new Error('Credential storage unavailable');
    const { apiKey, apiSecret, passphrase, ownerConfirmed } = parsed.data;
    const saved = await repository().saveCredential(admin.id, scope.provider, { apiKey, apiSecret, passphrase, ownerConfirmed });
    return { configured: saved.configured, updatedAt: saved.updatedAt };
  }, 201);
}

export async function DELETE(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async admin => {
    if (request.body !== null) throw new AdminDemoRequestValidationError('Invalid credential revocation request.');
    const scope = await resolveProvider(request, (await params).provider);
    if (await prerequisites(request, admin.id) || !approved(scope.provider) ||
        process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_DELETE_APPROVED !== 'true') {
      throw new Error('Credential removal unavailable');
    }
    return { revoked: await repository().revokeCredential(admin.id, scope.provider, { erase: true }) };
  });
}
