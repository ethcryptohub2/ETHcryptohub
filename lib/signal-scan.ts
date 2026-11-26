import type { QueryResultRow } from 'pg';
import { BinanceFuturesMarketsService, BinanceMarketDataError } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService, recommendedMaxAgeSeconds } from '../smartexit/apps/api/src/services/market-scanner';
import { binanceRateLimiter, BinanceCooldownError } from './binance-rate-limit';
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
  const cycleId = `CYCLE-${currentCycle}-FULL-RUN`;
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
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const cbStatus = binanceRateLimiter.getStatus(startedMs);
  if (cbStatus.state === 'OPEN' && cbStatus.cooldownUntil) {
    throw new SignalScanError(
      `Binance API cooldown active (HTTP ${cbStatus.statusCode ?? 418}). Resuming at ${new Date(cbStatus.cooldownUntil).toLocaleTimeString('en-US')}.`,
    );
  }

  const syncState = await getScannerSyncState();
  const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
  if (!lastAttempt || Date.now() - lastAttempt >= SYMBOL_SYNC_INTERVAL_MS) {
    await syncBinanceScannerUniverse(null).catch((err) => {
      if (err instanceof BinanceCooldownError) throw new SignalScanError(err.message);
      console.warn('Universe sync deferred:', err instanceof Error ? err.message : err);
    });
  }
  const settings = await getNotificationSystemSettings();
  const scannerConfig = await getScannerConfiguration();
  const effectiveMinimumVolume = options.minimumVolume ?? scannerConfig.minimumVolume;
  const effectiveBatchLimit = options.limit ?? scannerConfig.batchSize;

  const marketSnapshot = await markets.list().catch((error: unknown) => {
    if (error instanceof BinanceCooldownError) {
      throw new SignalScanError(error.message);
    }
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

  let symbols: string[];
  let cursorInfo = { offset: 0, cycleCount: 1, lastScannedAt: null as string | null, totalBatches: 1, batchIndex: 1, cycleId: 'MANUAL-BATCH' };
  if (options.symbols && options.symbols.length > 0) {
    symbols = options.symbols.filter((s) => enabledSymbols.includes(s));
  } else {
    // Complete dynamic universe: evaluate all 520+ enabled USDT perpetual contracts across dynamic batches without volume pre-truncation
    const pool = enabledSymbols;
    cursorInfo = await getAndAdvanceScannerCursor(pool.length, effectiveBatchLimit);
    symbols = Array.from({ length: Math.min(effectiveBatchLimit, pool.length) }, (_, index) =>
      pool[(cursorInfo.offset + index) % pool.length]!,
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
    lowVolume: 0,
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
      continue;
    }
    if ((c.score?.value ?? 0) < settings.minimumSetupScore) {
      rejectionBreakdown.insufficientScore++;
    }
    const text = `${c.rationale ?? ''} ${(c.warnings ?? []).join(' ')}`.toLowerCase();
    let classified = false;
    if (text.includes('volume') || text.includes('below the configured')) {
      rejectionBreakdown.lowVolume++;
      classified = true;
    }
    if (text.includes('ema') || text.includes('trend')) {
      rejectionBreakdown.trendConflict++;
      classified = true;
    }
    if (text.includes('supertrend')) {
      rejectionBreakdown.supertrendConflict++;
      classified = true;
    }
    if (text.includes('pivot')) {
      rejectionBreakdown.pivotProximity++;
      classified = true;
    }
    if (text.includes('rsi') || text.includes('macd') || text.includes('momentum')) {
      rejectionBreakdown.momentumConflict++;
      classified = true;
    }
    if (!classified && c.status !== 'READY') {
      rejectionBreakdown.other++;
    }
  }

  const skippedCount = result.candidates.filter((c) =>
    c.warnings.some((w) => w.includes('Skipped due to Binance cooldown')),
  ).length;
  const failedCount = result.candidates.filter((c) =>
    c.status === 'DATA_UNAVAILABLE' && !c.warnings.some((w) => w.includes('Skipped due to Binance cooldown')),
  ).length;
  const successfulCount = Math.max(0, result.candidates.length - failedCount - skippedCount);
  const durationMs = Date.now() - startedMs;
  const completedAt = new Date().toISOString();

  await safeDbQuery(
    `UPDATE public.app_settings
        SET value_json = COALESCE(value_json, '{}'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE key = 'scanner_rotation_state'`,
    [JSON.stringify({
      lastDurationMs: durationMs,
      lastScannedCount: result.candidates.length,
      lastSuccessfulCount: successfulCount,
      lastFailedCount: failedCount,
      lastSkippedCount: skippedCount,
      lastBatchIndex: cursorInfo.batchIndex,
      lastTotalBatches: cursorInfo.totalBatches,
      lastCompletedAt: completedAt,
    })],
  );

  return {
    startedAt,
    completedAt,
    durationMs,
    exchange: result.exchange,
    source: result.source,
    timeframe,
    scannerStatus: result.status,
    candidates: result.candidates.length,
    successfulCount,
    failedCount,
    skippedCount,
    qualifiedCount: qualifiedCandidates.length,
    enabledCoins: enabledSymbols.length,
    batchSize: symbols.length,
    cursor: cursorInfo.offset,
    newSignals: persisted.created,
    deduplicatedSignals: Math.max(0, qualifiedCandidates.length - persisted.created),
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

export async function runCompleteScannerCycle(
  timeframeOverride?: typeof timeframes[number],
  options: SignalScanOptions = {},
) {
  const startedAt = new Date().toISOString();
  const enabledSymbols = await getEnabledScannerSymbols();
  if (enabledSymbols.length === 0) {
    throw new SignalScanError('No enabled Binance USDT perpetual pairs were found.');
  }

  const batchSize = options.limit ? Math.min(options.limit, 50) : 35;
  const totalBatches = Math.ceil(enabledSymbols.length / batchSize);
  const scannedUniqueSymbols = new Set<string>();
  let totalQualified = 0;
  let totalCreatedSignals = 0;
  let totalDeduplicated = 0;
  const aggregatedRejections = {
    insufficientScore: 0,
    lowVolume: 0,
    trendConflict: 0,
    momentumConflict: 0,
    supertrendConflict: 0,
    pivotProximity: 0,
    dataUnavailable: 0,
    other: 0,
  };

  const batchResults: Array<Awaited<ReturnType<typeof runSignalScan>>> = [];
  const retrySymbols: string[] = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchSymbols = enabledSymbols.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
    try {
      const batchResult = await runSignalScan(timeframeOverride, {
        ...options,
        symbols: batchSymbols,
      });
      batchResults.push(batchResult);
      batchSymbols.forEach((s) => scannedUniqueSymbols.add(s));
      totalQualified += batchResult.qualifiedCount;
      totalCreatedSignals += batchResult.newSignals;
      totalDeduplicated += batchResult.deduplicatedSignals;

      for (const [key, val] of Object.entries(batchResult.rejections)) {
        if (key in aggregatedRejections) {
          aggregatedRejections[key as keyof typeof aggregatedRejections] += val;
        }
      }
    } catch (err) {
      console.warn(`[SCANNER FULL CYCLE] Batch ${batchIdx + 1}/${totalBatches} error:`, err);
      retrySymbols.push(...batchSymbols);
    }
  }

  if (retrySymbols.length > 0) {
    try {
      const retryResult = await runSignalScan(timeframeOverride, {
        ...options,
        symbols: retrySymbols.slice(0, 35),
      });
      retryResult.rows.forEach((r) => scannedUniqueSymbols.add(r.symbol));
      totalQualified += retryResult.qualifiedCount;
      totalCreatedSignals += retryResult.newSignals;
    } catch {
      // Retry attempted
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const coveragePercent = Number(((scannedUniqueSymbols.size / enabledSymbols.length) * 100).toFixed(2));

  return {
    cycleId: `CYCLE-FULL-${Date.now()}`,
    timeframe: timeframeOverride ?? '15m',
    startedAt,
    completedAt,
    durationMs,
    totalEligible: enabledSymbols.length,
    scannedUniqueCount: scannedUniqueSymbols.size,
    coveragePercent,
    totalBatches,
    completedBatches: batchResults.length,
    failedBatches: totalBatches - batchResults.length,
    qualifiedCount: totalQualified,
    newSignals: totalCreatedSignals,
    deduplicatedSignals: totalDeduplicated,
    rejections: aggregatedRejections,
    batchResults,
  };
}
