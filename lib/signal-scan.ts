import { BinanceFuturesMarketsService, BinanceMarketDataError } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService, recommendedMaxAgeSeconds } from '../smartexit/apps/api/src/services/market-scanner';
import { loadMarketResearchProvider } from './market-research-settings';
import {
  flushSignalNotifications,
  getNotificationSystemSettings,
  persistSignalScan,
  processSignalLifecycle,
} from './notifications';
import { processNewAutomaticTrades } from './trading-execution';
import {
  getEnabledScannerSymbols,
  getScannerSyncState,
  saveScannerCandidates,
  syncBinanceScannerUniverse,
} from './scanner-coins';

const timeframes = ['5m', '15m', '1h', '4h'] as const;
const DEFAULT_SYMBOL_BATCH_SIZE = 35;
const SYMBOL_SYNC_INTERVAL_MS = 15 * 60_000;
const markets = new BinanceFuturesMarketsService();

export type SignalScanOptions = {
  executeAutomaticTrades?: boolean;
  deliverNotifications?: boolean;
  symbols?: string[];
  limit?: number;
  minimumVolume?: number;
};

export class SignalScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalScanError';
  }
}

export async function runSignalScan(
  timeframeOverride?: typeof timeframes[number],
  options: SignalScanOptions = {},
) {
  const startedAt = new Date().toISOString();
  const syncState = await getScannerSyncState();
  const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
  if (!lastAttempt || Date.now() - lastAttempt >= SYMBOL_SYNC_INTERVAL_MS) {
    await syncBinanceScannerUniverse(null);
  }
  const settings = await getNotificationSystemSettings();
  const marketSnapshot = await markets.list().catch((error: unknown) => {
    if (error instanceof BinanceMarketDataError) {
      throw new SignalScanError('Binance exchange metadata or ticker acquisition failed. Check provider access before retrying.');
    }
    throw error;
  });
  const enabledSymbols = await getEnabledScannerSymbols();
  if (enabledSymbols.length === 0) {
    throw new SignalScanError('No enabled Binance USDT perpetual pairs were found. Sync the coin universe in Admin and retry.');
  }

  const minute = Math.floor(Date.now() / 60_000);
  const scanSlot = Math.floor(minute / 15);
  const timeframe = timeframeOverride ?? timeframes[scanSlot % timeframes.length]!;

  // Dynamic liquidity-ranked candidate selection: prioritize highest-volume liquid pairs
  const rawSnapshot = marketSnapshot as unknown;
  const snapshotSymbols = Array.isArray(rawSnapshot)
    ? (rawSnapshot as Array<{ quoteAsset?: string; symbol: string; quoteVolume24h?: number }>)
    : rawSnapshot && typeof rawSnapshot === 'object' && 'symbols' in rawSnapshot && Array.isArray((rawSnapshot as { symbols: unknown[] }).symbols)
      ? (rawSnapshot as { symbols: Array<{ quoteAsset?: string; symbol: string; quoteVolume24h?: number }> }).symbols
      : [];

  let symbols: string[];
  if (options.symbols && options.symbols.length > 0) {
    symbols = options.symbols.filter((s) => enabledSymbols.includes(s));
  } else if (snapshotSymbols.length > 0) {
    const liquidSnapshotPairs = snapshotSymbols
      .filter((m) => m && m.quoteAsset === 'USDT' && enabledSymbols.includes(m.symbol) && (m.quoteVolume24h ?? 0) >= (options.minimumVolume ?? 5_000_000))
      .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
      .map((m) => m.symbol);

    const batchLimit = options.limit ?? DEFAULT_SYMBOL_BATCH_SIZE;
    if (liquidSnapshotPairs.length > 0) {
      symbols = liquidSnapshotPairs.slice(0, Math.min(batchLimit, enabledSymbols.length));
    } else {
      const offset = (scanSlot * batchLimit) % enabledSymbols.length;
      symbols = Array.from({ length: Math.min(batchLimit, enabledSymbols.length) }, (_, index) =>
        enabledSymbols[(offset + index) % enabledSymbols.length]!,
      );
    }
  } else {
    const batchLimit = options.limit ?? DEFAULT_SYMBOL_BATCH_SIZE;
    const offset = (scanSlot * batchLimit) % enabledSymbols.length;
    symbols = Array.from({ length: Math.min(batchLimit, enabledSymbols.length) }, (_, index) =>
      enabledSymbols[(offset + index) % enabledSymbols.length]!,
    );
  }

  const config = {
    quoteAsset: 'USDT',
    timeframe,
    symbols,
    minimumVolume: options.minimumVolume ?? 5_000_000,
    limit: symbols.length,
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
  const persisted = await persistSignalScan(result.candidates, settings, {
    dispatchNotifications: options.deliverNotifications,
  });
  await processSignalLifecycle(marketSnapshot);
  if (options.executeAutomaticTrades !== false) {
    await processNewAutomaticTrades(persisted.createdSignalIds);
  }
  if (options.deliverNotifications !== false) {
    await flushSignalNotifications();
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    exchange: result.exchange,
    source: result.source,
    timeframe,
    scannerStatus: result.status,
    candidates: result.candidates.length,
    enabledCoins: enabledSymbols.length,
    batchSize: symbols.length,
    newSignals: persisted.created,
    scannedAt: result.updatedAt,
    rows: symbols.map(symbol => {
      const candidate = result.candidates.find(item => item.symbol === symbol);
      return {
        symbol, status: candidate?.status ?? 'DATA_UNAVAILABLE',
        side: candidate?.side ?? 'WAIT',
        candleCloseAt: candidate?.lastCandleCloseAt ?? null,
        reason: candidate?.warnings.find(warning => !warning.startsWith('EMA trend is based')) ??
          candidate?.rationale ?? 'No eligible provider market was returned for this symbol.',
        setup: candidate?.status === 'READY' ? candidate.setup : null,
      };
    }),
  };
}
