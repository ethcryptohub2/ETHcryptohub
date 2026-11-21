import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isPreviewMarketRequestApproved } from '../../../../lib/admin-demo-staging-policy';
import { acquireAlphaSnapshot } from '../../../../lib/alpha-intelligence';
import { alphaHistoryReadEnabled, readAlphaObservationHistory, storeApprovedAlphaObservations } from '../../../../lib/alpha-observation-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

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
    const hostname = request.nextUrl.hostname;
    if (request.nextUrl.search === '?history=1') {
      const data = await readAlphaObservationHistory(process.env, hostname);
      return data === null ? json({ error: 'ALPHA_HISTORY_DISABLED' }, 503) : json({ data });
    }
    if (request.nextUrl.search) return json({ error: 'INVALID_ALPHA_REQUEST' }, 422);
    return json({ enabled: approvedBatch(request) !== null,
      ...(alphaHistoryReadEnabled(process.env, hostname) ? { historyEnabled: true } : {}) });
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
    const archive = await storeApprovedAlphaObservations(process.env, request.nextUrl.hostname, tokenIds, data, request.signal);
    return json({ data, archive });
  } catch (error) {
    return json({ error: 'ALPHA_ACQUISITION_UNAVAILABLE' }, error instanceof AuthError ? error.status : 503);
  }
}
