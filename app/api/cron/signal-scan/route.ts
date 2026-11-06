import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  BinanceFuturesMarketsService,
} from '../../../../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService, recommendedMaxAgeSeconds } from '../../../../smartexit/apps/api/src/services/market-scanner';
import { loadMarketResearchProvider } from '../../../../lib/market-research-settings';
import {
  flushSignalNotifications,
  getNotificationSystemSettings,
  persistSignalScan,
  processSignalLifecycle,
} from '../../../../lib/notifications';
import {
  getEnabledScannerSymbols,
  getScannerSyncState,
  saveScannerCandidates,
  syncBinanceScannerUniverse,
} from '../../../../lib/scanner-coins';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const timeframes = ['5m', '15m', '1h', '4h'] as const;
const markets = new BinanceFuturesMarketsService();
const SYMBOL_BATCH_SIZE = 10;
const SYMBOL_SYNC_INTERVAL_MS = 15 * 60_000;

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secret || !supplied) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Scheduled scan authorization failed.' }, { status: 401 });
  }
  try {
    const syncState = await getScannerSyncState();
    const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
    if (!lastAttempt || Date.now() - lastAttempt >= SYMBOL_SYNC_INTERVAL_MS) {
      await syncBinanceScannerUniverse(null);
    }
    const settings = await getNotificationSystemSettings();
    const marketSnapshot = await markets.list();
    const enabledSymbols = await getEnabledScannerSymbols();
    const minute = Math.floor(Date.now() / 60_000);
    const timeframe = timeframes[minute % timeframes.length]!;
    const scanRound = Math.floor(minute / timeframes.length);
    const offset = enabledSymbols.length ? (scanRound * SYMBOL_BATCH_SIZE) % enabledSymbols.length : 0;
    const symbols = enabledSymbols.length
      ? Array.from({ length: Math.min(SYMBOL_BATCH_SIZE, enabledSymbols.length) }, (_, index) =>
        enabledSymbols[(offset + index) % enabledSymbols.length]!)
      : [];
    const config = {
      quoteAsset: 'USDT',
      timeframe,
      symbols,
      minimumVolume: 10_000_000,
      limit: 30,
      atrPeriod: 10,
      multiplier: 3,
      maxAgeSeconds: recommendedMaxAgeSeconds(timeframe),
      minimumScore: settings.minimumSetupScore,
    } as const;
    const researchProvider = await loadMarketResearchProvider();
    const scanner = new BinanceMarketScannerService(markets, globalThis.fetch, Date.now, researchProvider);
    const result = await scanner.scan(config);
    await saveScannerCandidates(result.candidates);
    const persisted = await persistSignalScan(result.candidates, settings);
    await processSignalLifecycle(marketSnapshot);
    await flushSignalNotifications();
    return NextResponse.json({
      data: {
        timeframe,
        scannerStatus: result.status,
        candidates: result.candidates.length,
        enabledCoins: enabledSymbols.length,
        batchSize: symbols.length,
        newSignals: persisted.created,
        scannedAt: result.updatedAt,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Scheduled signal scan failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Scheduled signal processing failed.' }, { status: 503 });
  }
}
