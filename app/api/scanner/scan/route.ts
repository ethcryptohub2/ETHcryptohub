import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../../lib/auth';
import { requirePremiumUser, SubscriptionError } from '../../../../lib/subscriptions';
import { runSignalScan, getScannerConfiguration, SignalScanError } from '../../../../lib/signal-scan';
import { runHighRiskScalpingScan } from '../../../../lib/high-risk-scalping';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const scanRequestSchema = z.object({
  timeframe: z.enum(['5m', '15m', '1h', '4h']).default('15m'),
  strategy: z.enum(['STANDARD', 'HIGH_RISK']).default('STANDARD'),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const noStore = { 'Cache-Control': 'no-store' };

async function checkAndAcquireScanLock(): Promise<{ acquired: boolean; lastResult?: unknown }> {
  try {
    const { query } = await import('../../../../lib/db');
    const res = await query<{ value_json: { lockedAt: number; status: string; lastResult?: unknown } }>(
      `SELECT value_json FROM public.app_settings WHERE key = 'scanner_execution_lock'`,
    );
    const lock = res.rows[0]?.value_json;
    const now = Date.now();
    if (lock && lock.status === 'RUNNING' && typeof lock.lockedAt === 'number' && now - lock.lockedAt < 10_000) {
      return { acquired: false, lastResult: lock.lastResult };
    }
    await query(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ('scanner_execution_lock', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
      [JSON.stringify({ lockedAt: now, status: 'RUNNING', startedAt: new Date().toISOString() })],
    );
    return { acquired: true };
  } catch {
    return { acquired: true };
  }
}

async function releaseScanLock(resultData?: unknown): Promise<void> {
  try {
    const { query } = await import('../../../../lib/db');
    await query(
      `UPDATE public.app_settings
       SET value_json = $1::jsonb, updated_at = NOW()
       WHERE key = 'scanner_execution_lock'`,
      [JSON.stringify({ lockedAt: Date.now(), status: 'IDLE', lastResult: resultData, completedAt: new Date().toISOString() })],
    );
  } catch {
    // Non-blocking cleanup
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePremiumUser({ reconcile: false });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Scanner access could not be verified. Try again.',
        ...(error instanceof SubscriptionError ? { code: error.code } : {}),
      },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 403, headers: noStore },
    );
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request payload.' }, { status: 400, headers: noStore });
  }

  const parsed = scanRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid scan options. Choose a supported timeframe and strategy.' },
      { status: 422, headers: noStore },
    );
  }

  const { timeframe, strategy, limit } = parsed.data;

  const lockStatus = await checkAndAcquireScanLock();
  if (!lockStatus.acquired && lockStatus.lastResult) {
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      data: lockStatus.lastResult,
    }, { headers: noStore });
  }

  try {
    if (strategy === 'HIGH_RISK') {
      const scanStart = Date.now();
      const result = await runHighRiskScalpingScan(globalThis.fetch, scanStart, { deliverNotifications: false });
      const durationMs = Date.now() - scanStart;
      const responseData = {
        strategy: 'HIGH_RISK' as const,
        enabled: result.enabled,
        scannedCount: result.scanned,
        createdSignals: result.created,
        failedCount: result.failed,
        batchSize: result.batchSize,
        enabledPairs: result.enabledPairs,
        timeframes: result.timeframes,
        completedAt: result.scannedAt,
        durationMs,
      };
      await releaseScanLock(responseData);
      return NextResponse.json({
        ok: true,
        data: responseData,
      }, { headers: noStore });
    }

    // Standard Strategy Scan
    const scanStart = Date.now();
    const result = await runSignalScan(timeframe, {
      executeAutomaticTrades: false,
      deliverNotifications: false,
      limit,
    });
    const durationMs = Date.now() - scanStart;

    const responseData = {
      strategy: 'STANDARD' as const,
      timeframe: result.timeframe,
      scannerStatus: result.scannerStatus,
      scannedCount: result.candidates,
      qualifiedCount: result.qualifiedCount,
      newSignals: result.newSignals,
      deduplicatedSignals: result.deduplicatedSignals,
      enabledCoins: result.enabledCoins,
      batchSize: result.batchSize,
      cycleId: result.cycleId,
      totalBatches: result.totalBatches,
      batchIndex: result.batchIndex,
      cycleCount: result.cycleCount,
      rejections: result.rejections,
      scannedAt: result.scannedAt,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs,
      rows: result.rows,
    };
    await releaseScanLock(responseData);

    return NextResponse.json({
      ok: true,
      data: responseData,
    }, { headers: noStore });
  } catch (error) {
    await releaseScanLock(null);
    console.error('On-demand scan error:', error);
    const message = error instanceof SignalScanError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Scan cycle encountered an unexpected error.';
    return NextResponse.json({ error: message }, { status: 500, headers: noStore });
  }
}

export async function GET() {
  try {
    await requirePremiumUser({ reconcile: false });
    const config = await getScannerConfiguration();
    const { getScannerSyncState } = await import('../../../../lib/scanner-coins');
    const syncState = await getScannerSyncState();
    return NextResponse.json({
      ok: true,
      data: {
        configuration: config,
        syncState,
      },
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Scanner info unavailable.' },
      { status: 503, headers: noStore },
    );
  }
}
