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

  try {
    if (strategy === 'HIGH_RISK') {
      const scanStart = Date.now();
      const result = await runHighRiskScalpingScan(globalThis.fetch, scanStart, { deliverNotifications: false });
      const durationMs = Date.now() - scanStart;
      return NextResponse.json({
        ok: true,
        data: {
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
        },
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

    return NextResponse.json({
      ok: true,
      data: {
        strategy: 'STANDARD' as const,
        timeframe: result.timeframe,
        scannerStatus: result.scannerStatus,
        scannedCount: result.candidates,
        qualifiedCount: result.qualifiedCount,
        newSignals: result.newSignals,
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
      },
    }, { headers: noStore });
  } catch (error) {
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
