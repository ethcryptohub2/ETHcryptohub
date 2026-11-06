import { BinanceFuturesMarketsService } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService, recommendedMaxAgeSeconds } from '../smartexit/apps/api/src/services/market-scanner';
import { loadMarketResearchProvider } from './market-research-settings';
import {
  flushSignalNotifications,
  getNotificationSystemSettings,
  persistSignalScan,
  processSignalLifecycle,
} from './notifications';
import {
  getEnabledScannerSymbols,
  getScannerSyncState,
  saveScannerCandidates,
  syncBinanceScannerUniverse,
} from './scanner-coins';

const timeframes = ['5m', '15m', '1h', '4h'] as const;
const SYMBOL_BATCH_SIZE = 10;
const SYMBOL_SYNC_INTERVAL_MS = 15 * 60_000;
const markets = new BinanceFuturesMarketsService();

export class SignalScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalScanError';
  }
}

export async function runSignalScan(timeframeOverride?: typeof timeframes[number]) {
  const syncState = await getScannerSyncState();
  const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
  if (!lastAttempt || Date.now() - lastAttempt >= SYMBOL_SYNC_INTERVAL_MS) {
    await syncBinanceScannerUniverse(null);
  }
  const settings = await getNotificationSystemSettings();
  const marketSnapshot = await markets.list();
  const enabledSymbols = await getEnabledScannerSymbols();
  if (enabledSymbols.length === 0) {
    throw new SignalScanError('No enabled Binance USDT perpetual pairs were found. Sync the coin universe in Admin and retry.');
  }

  const minute = Math.floor(Date.now() / 60_000);
  const scanSlot = Math.floor(minute / 15);
  const timeframe = timeframeOverride ?? timeframes[scanSlot % timeframes.length]!;
  const scanRound = scanSlot;
  const offset = (scanRound * SYMBOL_BATCH_SIZE) % enabledSymbols.length;
  const symbols = Array.from({ length: Math.min(SYMBOL_BATCH_SIZE, enabledSymbols.length) }, (_, index) =>
    enabledSymbols[(offset + index) % enabledSymbols.length]!,
  );
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
  if (result.candidates.length === 0) {
    throw new SignalScanError('Binance returned no eligible markets for this scan batch. Retry after the next market-data refresh.');
  }

  await saveScannerCandidates(result.candidates);
  const persisted = await persistSignalScan(result.candidates, settings);
  await processSignalLifecycle(marketSnapshot);
  await flushSignalNotifications();
  return {
    timeframe,
    scannerStatus: result.status,
    candidates: result.candidates.length,
    enabledCoins: enabledSymbols.length,
    batchSize: symbols.length,
    newSignals: persisted.created,
    scannedAt: result.updatedAt,
  };
}
