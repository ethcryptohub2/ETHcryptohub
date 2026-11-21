import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isPreviewMarketRequestApproved } from '../../../../lib/admin-demo-staging-policy';
import { acquireAlphaSnapshot } from '../../../../lib/alpha-intelligence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
let nextAttemptAt = 0;

function approvedBatch(request: NextRequest) {
  if (!isPreviewMarketRequestApproved(process.env, request.nextUrl.hostname, 'ALPHA_INTELLIGENCE')) return null;
  const ids = (process.env.SMARTEXIT_ALPHA_INTELLIGENCE_TOKEN_IDS ?? '').split(',').map(id => id.trim());
  return ids.length >= 1 && ids.length <= 2 && new Set(ids).size === ids.length &&
    ids.every(id => /^ALPHA_\d{1,12}$/.test(id)) ? ids : null;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
    return json({ enabled: approvedBatch(request) !== null });
  } catch (error) {
    return json({ error: 'ALPHA_READINESS_UNAVAILABLE' }, error instanceof AuthError ? error.status : 503);
  }
}

export async function POST(request: NextRequest) {
  const rejected = guardedPost(request);
  if (rejected) return rejected;
  try {
    await requireAdmin();
    if (request.body !== null || request.nextUrl.search) return json({ error: 'INVALID_ALPHA_REQUEST' }, 422);
    const tokenIds = approvedBatch(request);
    if (!tokenIds) return json({ error: 'ALPHA_APPROVAL_REQUIRED' }, 503);
    const now = performance.now();
    if (now < nextAttemptAt) return json({ error: 'ALPHA_COOLDOWN' }, 429);
    nextAttemptAt = now + 60_000;
    const data = await acquireAlphaSnapshot({ approved: true, tokenIds, transport: fetch, signal: request.signal });
    return json({ data });
  } catch (error) {
    return json({ error: 'ALPHA_ACQUISITION_UNAVAILABLE' }, error instanceof AuthError ? error.status : 503);
  }
}
