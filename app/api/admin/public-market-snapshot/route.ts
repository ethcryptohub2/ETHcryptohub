import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isApprovedAdminDemoStagingTarget } from '../../../../lib/admin-demo-staging-policy';
import { fetchPublicRestSnapshot } from '../../../../lib/intelligence/public-rest-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const json = (body: object, status: number) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
let nextAttemptAt = 0;

export async function POST(request: NextRequest) {
  const rejected = guardedPost(request);
  if (rejected) return rejected;
  try {
    await requireAdmin();
    if (request.nextUrl.search || request.body !== null) return json({ state: 'INVALID_REQUEST' }, 422);
    if (process.env.SMARTEXIT_PUBLIC_REST_SNAPSHOT_ENABLED !== 'true' ||
        process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF !== 'ghecpkpaxbrvehquhzkr' ||
        !isApprovedAdminDemoStagingTarget(process.env)) return json({ state: 'DISABLED' }, 503);
    const now = performance.now();
    if (now < nextAttemptAt) return json({ state: 'COOLDOWN' }, 429);
    nextAttemptAt = now + 60_000;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const result = await fetchPublicRestSnapshot(signal);
    if ([403, 418, 429, 451].includes(result.status)) nextAttemptAt = Infinity;
    return json(result, result.state === 'UNAVAILABLE' ? 503 : 200);
  } catch (error) {
    return json({ state: error instanceof AuthError ? 'ACCESS_DENIED' : 'UNAVAILABLE' },
      error instanceof AuthError ? error.status : 503);
  }
}
