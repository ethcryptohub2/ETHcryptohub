import { NextRequest, NextResponse } from 'next/server';
import process from 'node:process';
import { forwardRequestToBackend, shouldForwardToBackend } from '../../../lib/backend-proxy';
import { binanceRateLimiter } from '../../../lib/binance-rate-limit';
import { sharedCandleCache } from '../../../lib/candle-cache';
import { isDatabaseConfigured, query } from '../../../lib/db';
import { getScannerV2State } from '../../../lib/scanner-scheduler';
import { binanceWsKlineEngine } from '../../../lib/ws-kline-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  if (shouldForwardToBackend()) {
    try {
      const forwarded = await forwardRequestToBackend(
        request,
        `/api/health${request.nextUrl.search}`,
        { method: 'GET', timeoutMs: 10_000 },
      );
      if (forwarded) return forwarded;
    } catch {
      // Fall through to local degraded diagnostic if backend unreachable
    }
  }
  const readyCheck = request.nextUrl.searchParams.get('ready') === '1';
  const mem = process.memoryUsage();

  let dbOk = false;
  let dbLatencyMs: number | null = null;
  if (isDatabaseConfigured()) {
    const start = Date.now();
    try {
      await query('SELECT 1');
      dbOk = true;
      dbLatencyMs = Date.now() - start;
    } catch {
      dbOk = false;
    }
  }

  const wsHealth = binanceWsKlineEngine.getHealth();
  const cb = binanceRateLimiter.getStatus();
  const v2 = await getScannerV2State().catch(() => null);

  const ok = readyCheck ? dbOk : true;
  return NextResponse.json(
    {
      ok,
      status: ok ? 'HEALTHY' : 'DEGRADED',
      service: 'smartexit-staging',
      environment: process.env.SMARTEXIT_DEPLOYMENT_ENV || 'staging',
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      database: {
        configured: isDatabaseConfigured(),
        ok: dbOk,
        latencyMs: dbLatencyMs,
      },
      binanceRateLimit: {
        state: cb.state,
        usedWeight1m: cb.usedWeight1m,
        weightLimit1m: cb.weightLimit1m,
      },
      webSocket: wsHealth,
      scanner: v2
        ? {
            state: v2.state,
            totalEligible: v2.totalEligible,
            successfulCount: v2.successfulCount,
            failedCount: v2.failedCount,
            skippedCount: v2.skippedCount,
            coveragePercent: v2.coveragePercent,
            cacheEntries: sharedCandleCache.size(),
            lastSuccessfulScanAt: v2.lastSuccessfulScanAt,
          }
        : null,
    },
    { status: ok ? 200 : 503, headers: noStore },
  );
}
