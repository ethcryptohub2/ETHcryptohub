import type { NextRequest } from 'next/server';
import { AdminDemoRequestValidationError, type AdminDemoRouteContext, resolveProvider, withAdmin, withMutation } from '../../_shared';
import { isApprovedAdminDemoStagingTarget } from '../../../../../../../lib/admin-demo-staging-policy';
import { AdminDemoProviderSecurityError } from '../../../../../../../lib/admin-demo-provider-security';
import { supportsApprovedDemoRead } from '../../../../../../../lib/admin-demo-read-transport';
import { isCredentialEncryptionConfigured } from '../../../../../../../lib/binance-credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function approval(request: NextRequest, provider: string, adminId: number) {
  const env = process.env;
  const sha = env.SMARTEXIT_ADMIN_DEMO_READ_APPROVED_SHA;
  const until = env.SMARTEXIT_ADMIN_DEMO_READ_APPROVED_UNTIL ?? '';
  const remaining = Date.parse(until) - Date.now();
  const currentBranch = env.RENDER_GIT_BRANCH || env.VERCEL_GIT_COMMIT_REF || env.SMARTEXIT_DEPLOYMENT_BRANCH;
  const currentSha = env.RENDER_GIT_COMMIT || env.VERCEL_GIT_COMMIT_SHA;
  const currentHost = env.RENDER_EXTERNAL_HOSTNAME || env.VERCEL_URL || (env.APP_URL ? new URL(env.APP_URL).hostname : null);
  const isStaging = env.VERCEL_ENV === 'preview' || env.SMARTEXIT_DEPLOYMENT_ENV === 'staging';

  return isStaging && currentBranch === 'functional-staging' &&
    env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' && isApprovedAdminDemoStagingTarget(env) &&
    (request.nextUrl.hostname === currentHost || (currentHost && request.nextUrl.hostname.endsWith('.onrender.com'))) &&
    sha && /^[a-f0-9]{40}$/.test(sha) && sha === currentSha &&
    provider === env.SMARTEXIT_ADMIN_DEMO_READ_APPROVED_PROVIDER &&
    String(adminId) === env.SMARTEXIT_ADMIN_DEMO_READ_APPROVED_ADMIN_ID &&
    remaining > 0 && remaining <= 15 * 60_000 ? until : null;
}

export async function GET(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withAdmin(async admin => {
    const { provider } = await resolveProvider(request, (await params).provider);
    if (!supportsApprovedDemoRead(provider)) return { state: 'UNSUPPORTED', enabled: false };
    const window = approval(request, provider, admin.id);
    if (!window || !isCredentialEncryptionConfigured()) return { state: 'APPROVAL_REQUIRED', enabled: false };
    return { state: 'DURABLE_CLAIM_REQUIRED', enabled: false };
  });
}

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async admin => {
    if (request.body !== null) throw new AdminDemoRequestValidationError('Use an empty Demo read request.');
    const { provider } = await resolveProvider(request, (await params).provider);
    const window = approval(request, provider, admin.id);
    if (!supportsApprovedDemoRead(provider) || !window || !isCredentialEncryptionConfigured()) {
      throw new AdminDemoProviderSecurityError('This Demo read has no verified approval window.', 503);
    }
    throw new AdminDemoProviderSecurityError('This Demo read requires a durable one-time approval claim.', 503);
  });
}
