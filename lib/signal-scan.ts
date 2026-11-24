import type { QueryResultRow } from 'pg';
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
const DEFAULT_MINIMUM_VOLUME = 5_000_000;
const SYMBOL_SYNC_INTERVAL_MS = 15 * 60_000;
const markets = new BinanceFuturesMarketsService();

export type ScannerConfiguration = {
  minimumVolume: number;
  batchSize: number;
  updatedAt?: string;
};

export type ScannerRotationState = {
  cursor: number;
  cycleCount: number;
  lastScannedAt: string | null;
  totalEligible: number;
};

async function safeDbQuery<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  try {
    const { query } = await import('./db');
    return await query<T>(sql, params);
  } catch {
    return { rows: [] };
  }
}

export async function getScannerConfiguration(): Promise<ScannerConfiguration> {
  const res = await safeDbQuery<{ value_json: ScannerConfiguration }>(
    `SELECT value_json FROM public.app_settings WHERE key = 'scanner_configuration'`,
  );
  if (res.rows[0]?.value_json) {
    const val = res.rows[0].value_json;
    return {
      minimumVolume: Number(val.minimumVolume) || DEFAULT_MINIMUM_VOLUME,
      batchSize: Number(val.batchSize) || DEFAULT_SYMBOL_BATCH_SIZE,
      updatedAt: val.updatedAt,
    };
  }
  return { minimumVolume: DEFAULT_MINIMUM_VOLUME, batchSize: DEFAULT_SYMBOL_BATCH_SIZE };
}

export async function updateScannerConfiguration(config: { minimumVolume?: number; batchSize?: number }) {
  const current = await getScannerConfiguration();
  const updated: ScannerConfiguration = {
    minimumVolume: config.minimumVolume !== undefined ? config.minimumVolume : current.minimumVolume,
    batchSize: config.batchSize !== undefined ? config.batchSize : current.batchSize,
    updatedAt: new Date().toISOString(),
  };
  await safeDbQuery(
    `INSERT INTO public.app_settings (key, value_json, updated_at)
     VALUES ('scanner_configuration', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify(updated)],
  );
  return updated;
}

export async function getAndAdvanceScannerCursor(
  totalItems: number,
  batchLimit: number,
): Promise<{
  offset: number;
  cycleCount: number;
  lastScannedAt: string | null;
  totalBatches: number;
  batchIndex: number;
  cycleId: string;
}> {
  if (totalItems <= 0) {
    return { offset: 0, cycleCount: 1, lastScannedAt: null, totalBatches: 1, batchIndex: 1, cycleId: 'CYCLE-1-BATCH-1-OF-1' };
  }
  const res = await safeDbQuery<{ value_json: { cursor: number; cycleCount: number; lastScannedAt: string | null } }>(
    `SELECT value_json FROM public.app_settings WHERE key = 'scanner_rotation_state'`,
  );
  const existing = res.rows[0]?.value_json;
  const currentCursor = typeof existing?.cursor === 'number' && Number.isFinite(existing.cursor) ? existing.cursor : 0;
  const currentCycle = typeof existing?.cycleCount === 'number' && Number.isFinite(existing.cycleCount) ? existing.cycleCount : 1;

  const totalBatches = Math.max(1, Math.ceil(totalItems / batchLimit));
  const offset = currentCursor % totalItems;
  const batchIndex = Math.min(totalBatches, Math.floor(offset / batchLimit) + 1);
  const cycleId = `CYCLE-${currentCycle}-BATCH-${batchIndex}-OF-${totalBatches}`;
  const nextCursor = (offset + batchLimit) % totalItems;
  const nextCycle = currentCycle + (offset + batchLimit >= totalItems ? 1 : 0);
  const nowIso = new Date().toISOString();

  await safeDbQuery(
    `INSERT INTO public.app_settings (key, value_json, updated_at)
     VALUES ('scanner_rotation_state', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify({ cursor: nextCursor, cycleCount: nextCycle, lastScannedAt: nowIso, totalEligible: totalItems, cycleId })],
  );

  return { offset, cycleCount: currentCycle, lastScannedAt: existing?.lastScannedAt ?? null, totalBatches, batchIndex, cycleId };
}

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
  const scannerConfig = await getScannerConfiguration();
  const effectiveMinimumVolume = options.minimumVolume ?? scannerConfig.minimumVolume;
  const effectiveBatchLimit = options.limit ?? scannerConfig.batchSize;

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
  let cursorInfo = { offset: 0, cycleCount: 1, lastScannedAt: null as string | null, totalBatches: 1, batchIndex: 1, cycleId: 'MANUAL-BATCH' };
  if (options.symbols && options.symbols.length > 0) {
    symbols = options.symbols.filter((s) => enabledSymbols.includes(s));
  } else if (snapshotSymbols.length > 0) {
    const liquidSnapshotPairs = snapshotSymbols
      .filter((m) => m && m.quoteAsset === 'USDT' && enabledSymbols.includes(m.symbol) && (m.quoteVolume24h ?? 0) >= effectiveMinimumVolume)
      .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
      .map((m) => m.symbol);

    const pool = liquidSnapshotPairs.length > 0 ? liquidSnapshotPairs : enabledSymbols;
    cursorInfo = await getAndAdvanceScannerCursor(pool.length, effectiveBatchLimit);
    symbols = Array.from({ length: Math.min(effectiveBatchLimit, pool.length) }, (_, index) =>
      pool[(cursorInfo.offset + index) % pool.length]!,
    );
  } else {
    cursorInfo = await getAndAdvanceScannerCursor(enabledSymbols.length, effectiveBatchLimit);
    symbols = Array.from({ length: Math.min(effectiveBatchLimit, enabledSymbols.length) }, (_, index) =>
      enabledSymbols[(cursorInfo.offset + index) % enabledSymbols.length]!,
    );
  }

  const config = {
    quoteAsset: 'USDT',
    timeframe,
    symbols,
    minimumVolume: effectiveMinimumVolume,
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

  const qualifiedCandidates = result.candidates.filter((item) => item.status === 'READY' && item.setup);
  const rejectionBreakdown = {
    insufficientScore: 0,
    trendConflict: 0,
    momentumConflict: 0,
    supertrendConflict: 0,
    pivotProximity: 0,
    dataUnavailable: 0,
    other: 0,
  };
  for (const c of result.candidates) {
    if (c.status === 'READY' && c.setup) continue;
    if (c.status === 'DATA_UNAVAILABLE') {
      rejectionBreakdown.dataUnavailable++;
    } else if ((c.score?.value ?? 0) < settings.minimumSetupScore) {
      rejectionBreakdown.insufficientScore++;
    }
    const text = `${c.rationale ?? ''} ${(c.warnings ?? []).join(' ')}`.toLowerCase();
    if (text.includes('ema') || text.includes('trend')) rejectionBreakdown.trendConflict++;
    if (text.includes('supertrend')) rejectionBreakdown.supertrendConflict++;
    if (text.includes('pivot')) rejectionBreakdown.pivotProximity++;
    if (text.includes('rsi') || text.includes('macd') || text.includes('momentum')) rejectionBreakdown.momentumConflict++;
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    exchange: result.exchange,
    source: result.source,
    timeframe,
    scannerStatus: result.status,
    candidates: result.candidates.length,
    qualifiedCount: qualifiedCandidates.length,
    enabledCoins: enabledSymbols.length,
    batchSize: symbols.length,
    newSignals: persisted.created,
    scannedAt: result.updatedAt,
    cycleId: cursorInfo.cycleId,
    totalBatches: cursorInfo.totalBatches,
    batchIndex: cursorInfo.batchIndex,
    cycleCount: cursorInfo.cycleCount,
    rejections: rejectionBreakdown,
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
