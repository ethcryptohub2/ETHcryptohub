import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { guardedPost } from '../../../../lib/http';
import { isPreviewMarketRequestApproved } from '../../../../lib/admin-demo-staging-policy';
import { pool } from '../../../../lib/db';
import { getEnabledScannerSymbols } from '../../../../lib/scanner-coins';
import { getNotificationSystemSettings } from '../../../../lib/notifications';
import { getHighRiskScalpingSettings } from '../../../../lib/high-risk-scalping';
import { evaluateStagingScanner, scannerEvaluationBatchLimit, ScannerEvaluationFailure } from '../../../../lib/staging-scanner-evaluation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const input = z.object({ symbols: z.array(z.string().regex(/^[A-Z0-9]{1,20}USDT$/))
  .min(1).max(scannerEvaluationBatchLimit).refine(values => new Set(values).size === values.length) }).strict();
const json = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function enabled(request: NextRequest) {
  return isPreviewMarketRequestApproved(process.env, request.nextUrl.hostname, 'SCANNER_EVALUATION');
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
    return json({ enabled: enabled(request), batchLimit: scannerEvaluationBatchLimit });
  } catch (error) {
    return json({ error: 'ADMIN_ACCESS_REQUIRED' }, error instanceof AuthError ? error.status : 503);
  }
}

export async function POST(request: NextRequest) {
  const rejected = guardedPost(request);
  if (rejected) return rejected;
  try {
    await requireAdmin();
    if (!enabled(request)) return json({ error: 'EVALUATION_REQUIRES_SEPARATE_APPROVAL' }, 503);
    const length = Number(request.headers.get('content-length'));
    if (!Number.isInteger(length) || length < 1 || length > 512) return json({ error: 'INVALID_SYMBOL_BATCH' }, 422);
    const parsed = input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'INVALID_SYMBOL_BATCH' }, 422);
    const [eligible, standard, highRisk] = await Promise.all([
      getEnabledScannerSymbols(), getNotificationSystemSettings(), getHighRiskScalpingSettings(),
    ]);
    const allowed = new Set(eligible);
    if (parsed.data.symbols.some(symbol => !allowed.has(symbol))) return json({ error: 'SYMBOL_NOT_ENABLED_IN_STAGING' }, 422);
    if (request.signal.aborted) return json({ error: 'EVALUATION_CANCELLED' }, 408);
    const client = await pool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      // Transaction-scoped lock is shared by Preview instances and survives pooler transaction mode.
      const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(783121, 501) AS acquired');
      if (!lock.rows[0]?.acquired) return json({ error: 'EVALUATION_BUSY' }, 429);
      if (!enabled(request)) return json({ error: 'EVALUATION_REQUIRES_SEPARATE_APPROVAL' }, 503);
      const started = performance.now();
      try {
        const result = await evaluateStagingScanner({
          symbols: parsed.data.symbols, minimumScore: standard.minimumSetupScore, highRisk,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        });
        return json({ data: result });
      } finally {
        // Hold the shared lock for at least ten seconds per admitted request.
        await delay(Math.max(0, 10_000 - (performance.now() - started)));
      }
    } finally {
      let rollbackError: Error | undefined;
      try { await client.query('ROLLBACK'); }
      catch { rollbackError = new Error('Could not release evaluation transaction'); }
      client.release(rollbackError);
    }
  } catch (error) {
    if (error instanceof AuthError) return json({ error: 'ADMIN_ACCESS_REQUIRED' }, error.status);
    if (error instanceof ScannerEvaluationFailure) return json({ error: error.code, providerStatus: error.providerStatus }, 503);
    return json({ error: 'EVALUATION_APPLICATION_ERROR' }, 503);
  }
}
