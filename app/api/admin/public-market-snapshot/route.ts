import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isPreviewMarketRequestApproved } from '../../../../lib/admin-demo-staging-policy';
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
  let providerSignal: AbortSignal | undefined;
  try {
    await requireAdmin();
    if (request.nextUrl.search || request.body !== null) return json({ state: 'INVALID_REQUEST' }, 422);
    if (!isPreviewMarketRequestApproved(process.env, request.nextUrl.hostname, 'PUBLIC_REST_SNAPSHOT')) {
      return json({ state: 'DISABLED' }, 503);
    }
    const now = performance.now();
    if (now < nextAttemptAt) return json({ state: 'COOLDOWN' }, 429);
    nextAttemptAt = now + 60_000;
    providerSignal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const result = await fetchPublicRestSnapshot(providerSignal);
    if ([403, 418, 429, 451].includes(result.status)) nextAttemptAt = Infinity;
    return json(result, result.state === 'UNAVAILABLE' ? 503 : 200);
  } catch (error) {
    return json({ state: error instanceof AuthError ? 'ACCESS_DENIED' : 'UNAVAILABLE',
      reason: providerSignal?.aborted ? 'TIMEOUT_OR_CANCELLED' : providerSignal ? 'NETWORK_OR_INVALID_PROVIDER_DATA' : 'APPLICATION_ERROR' },
      error instanceof AuthError ? error.status : 503);
  }
}
