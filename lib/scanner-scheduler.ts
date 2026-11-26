import type { QueryResultRow } from 'pg';
import { binanceRateLimiter, BinanceCooldownError } from './binance-rate-limit';
import { ensureBinanceCooldownHydrated } from './binance-rate-limit-db';
import { sharedCandleCache } from './candle-cache';
import { runHybridParallelWorkPool, type ScannerV2LifecycleState } from './hybrid-scanner-v2';
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
import { binanceWsKlineEngine } from './ws-kline-engine';
import { BinanceFuturesMarketsService, BinanceMarketDataError } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { BinanceMarketScannerService, recommendedMaxAgeSeconds } from '../smartexit/apps/api/src/services/market-scanner';

export const FULL_SCAN_INTERVAL_MS = 300_000; // 5 minutes
export const DEFAULT_V2_BATCH_SIZE = 32;
export const DEFAULT_V2_CONCURRENCY = 4; // Selected from 2/4/6 worker pool benchmark
const SCANNER_V2_STATE_KEY = 'scanner_v2_state';

export interface ScannerV2PersistedState {
  version: 'Hybrid Parallel V2';
  state: ScannerV2LifecycleState;
  cycleId: string;
  timeframe: '5m' | '15m' | '1h' | '4h';
  concurrency: number;
  totalEligible: number;
  totalBatches: number;
  completedBatches: number;
  activeWorkers: number;
  successfulCount: number;
  failedCount: number;
  skippedCount: number;
  qualifiedCount: number;
  newSignals: number;
  deduplicatedSignals: number;
  coveragePercent: number;
  startedAt: string | null;
  lastSuccessfulScanAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  nextScanAt: string | null;
  usedWeight1m: number;
  weightLimit1m: number;
  cooldownUntil: number | null;
  cooldownReason: string | null;
  standardStatus: 'ACTIVE' | 'COOLDOWN' | 'ERROR' | 'IDLE';
  highRiskStatus: 'ACTIVE' | 'COOLDOWN' | 'DISABLED' | 'IDLE';
  cacheEntries: number;
}

const markets = new BinanceFuturesMarketsService();
let activeCyclePromise: Promise<ScannerV2PersistedState> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

async function safeDbQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  try {
    const { query } = await import('./db');
    return await query<T>(sql, params);
  } catch {
    return { rows: [] };
  }
}

export function defaultScannerV2State(): ScannerV2PersistedState {
  const cb = binanceRateLimiter.getStatus();
  return {
    version: 'Hybrid Parallel V2',
    state: cb.state === 'OPEN' ? 'RATE_LIMIT_COOLDOWN' : 'INITIALIZING',
    cycleId: 'V2-INIT',
    timeframe: '15m',
    concurrency: DEFAULT_V2_CONCURRENCY,
    totalEligible: 0,
    totalBatches: 0,
    completedBatches: 0,
    activeWorkers: 0,
    successfulCount: 0,
    failedCount: 0,
    skippedCount: 0,
    qualifiedCount: 0,
    newSignals: 0,
    deduplicatedSignals: 0,
    coveragePercent: 0,
    startedAt: null,
    lastSuccessfulScanAt: null,
    completedAt: null,
    durationMs: null,
    nextScanAt: new Date(Date.now() + FULL_SCAN_INTERVAL_MS).toISOString(),
    usedWeight1m: cb.usedWeight1m,
    weightLimit1m: cb.weightLimit1m,
    cooldownUntil: cb.cooldownUntil,
    cooldownReason: cb.reason,
    standardStatus: cb.state === 'OPEN' ? 'COOLDOWN' : 'IDLE',
    highRiskStatus: cb.state === 'OPEN' ? 'COOLDOWN' : 'IDLE',
    cacheEntries: sharedCandleCache.size(),
  };
}

export async function saveScannerV2State(state: ScannerV2PersistedState): Promise<void> {
  await safeDbQuery(
    `INSERT INTO public.app_settings (key, value_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [SCANNER_V2_STATE_KEY, JSON.stringify(state)],
  );
}

export async function getScannerV2State(): Promise<ScannerV2PersistedState> {
  const cb = await ensureBinanceCooldownHydrated();
  const res = await safeDbQuery<{ value_json: Partial<ScannerV2PersistedState> }>(
    `SELECT value_json FROM public.app_settings WHERE key = $1`,
    [SCANNER_V2_STATE_KEY],
  );
  const base = defaultScannerV2State();
  const stored = res.rows[0]?.value_json;
  const merged: ScannerV2PersistedState = stored ? { ...base, ...stored } : base;

  // Always reflect live circuit-breaker and cache status
  merged.usedWeight1m = cb.usedWeight1m;
  merged.weightLimit1m = cb.weightLimit1m;
  merged.cooldownUntil = cb.cooldownUntil;
  merged.cooldownReason = cb.reason;
  merged.cacheEntries = sharedCandleCache.size();

  if (cb.state === 'OPEN') {
    merged.state = 'RATE_LIMIT_COOLDOWN';
    merged.standardStatus = 'COOLDOWN';
    merged.highRiskStatus = 'COOLDOWN';
  } else if (merged.state === 'COMPLETED' && merged.nextScanAt && Date.parse(merged.nextScanAt) > Date.now()) {
    merged.state = 'WAITING_FOR_NEXT_CYCLE';
  }

  return merged;
}

export async function triggerCoordinatedV2Scan(options: {
  timeframe?: '5m' | '15m' | '1h' | '4h';
  deliverNotifications?: boolean;
  concurrency?: number;
  batchSize?: number;
  signal?: AbortSignal;
} = {}): Promise<{ state: ScannerV2PersistedState; deduplicated: boolean }> {
  // Single-flight: if a V2 cycle is already running in this instance, join it
  if (activeCyclePromise) {
    const state = await activeCyclePromise;
    return { state, deduplicated: true };
  }

  const runPromise = executeCoordinatedV2Cycle(options);
  activeCyclePromise = runPromise;
  try {
    const state = await runPromise;
    return { state, deduplicated: false };
  } finally {
    if (activeCyclePromise === runPromise) {
      activeCyclePromise = null;
    }
  }
}

async function executeCoordinatedV2Cycle(options: {
  timeframe?: '5m' | '15m' | '1h' | '4h';
  deliverNotifications?: boolean;
  concurrency?: number;
  batchSize?: number;
  signal?: AbortSignal;
}): Promise<ScannerV2PersistedState> {
  const timeframe = options.timeframe ?? '15m';
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const cycleId = `V2-${startedMs}`;

  const cb = await ensureBinanceCooldownHydrated(startedMs);
  const existing = await getScannerV2State();

  if (cb.state === 'OPEN') {
    const cooldownState: ScannerV2PersistedState = {
      ...existing,
      version: 'Hybrid Parallel V2',
      state: 'RATE_LIMIT_COOLDOWN',
      timeframe,
      usedWeight1m: cb.usedWeight1m,
      weightLimit1m: cb.weightLimit1m,
      cooldownUntil: cb.cooldownUntil,
      cooldownReason: cb.reason,
      standardStatus: 'COOLDOWN',
      highRiskStatus: 'COOLDOWN',
      activeWorkers: 0,
    };
    await saveScannerV2State(cooldownState);
    return cooldownState;
  }

  try {
    const syncState = await getScannerSyncState();
    const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
    if (!lastAttempt || Date.now() - lastAttempt >= 15 * 60_000) {
      await syncBinanceScannerUniverse(null).catch((err) => {
        if (err instanceof BinanceCooldownError) throw err;
      });
    }

    const enabledSymbols = await getEnabledScannerSymbols();
    const settings = await getNotificationSystemSettings();
    const researchProvider = await loadMarketResearchProvider();

    // Ensure WebSocket kline stream is tracking top universe pairs if permitted
    if (binanceRateLimiter.getStatus().state !== 'OPEN') {
      binanceWsKlineEngine.start(enabledSymbols.slice(0, 180), timeframe);
    }

    const marketSnapshot = await markets.list().catch((err: unknown) => {
      if (err instanceof BinanceCooldownError) throw err;
      if (err instanceof BinanceMarketDataError) {
        throw new Error('Binance market metadata acquisition failed.');
      }
      throw err;
    });

    const scannerService = new BinanceMarketScannerService(markets, globalThis.fetch, Date.now, researchProvider);
    const maxAgeSeconds = recommendedMaxAgeSeconds(timeframe);

    const runningState: ScannerV2PersistedState = {
      ...existing,
      version: 'Hybrid Parallel V2',
      state: 'SCANNING',
      cycleId,
      timeframe,
      concurrency: options.concurrency ?? DEFAULT_V2_CONCURRENCY,
      totalEligible: enabledSymbols.length,
      totalBatches: Math.ceil(enabledSymbols.length / (options.batchSize ?? DEFAULT_V2_BATCH_SIZE)),
      completedBatches: 0,
      activeWorkers: options.concurrency ?? DEFAULT_V2_CONCURRENCY,
      successfulCount: 0,
      failedCount: 0,
      skippedCount: 0,
      startedAt,
      standardStatus: 'ACTIVE',
      highRiskStatus: 'ACTIVE',
    };
    await saveScannerV2State(runningState);

    const summary = await runHybridParallelWorkPool({
      cycleId,
      symbols: enabledSymbols,
      batchSize: options.batchSize ?? DEFAULT_V2_BATCH_SIZE,
      concurrency: options.concurrency ?? DEFAULT_V2_CONCURRENCY,
      signal: options.signal,
      processBatch: async (batchSymbols) => {
        const result = await scannerService.scan({
          quoteAsset: 'USDT',
          timeframe,
          symbols: batchSymbols,
          minimumVolume: 5_000_000,
          limit: batchSymbols.length,
          atrPeriod: 10,
          multiplier: 3,
          maxAgeSeconds,
          minimumScore: settings.minimumSetupScore,
        });

        await saveScannerCandidates(result.candidates);
        const persisted = await persistSignalScan(result.candidates, settings, {
          dispatchNotifications: options.deliverNotifications ?? true,
        });
        if ((options.deliverNotifications ?? true) && persisted.created > 0) {
          await flushSignalNotifications();
        }

        const skipped = result.candidates.filter((c) =>
          c.warnings.some((w) => w.includes('Skipped due to Binance cooldown')),
        ).length;
        const failed = result.candidates.filter((c) =>
          c.status === 'DATA_UNAVAILABLE' && !c.warnings.some((w) => w.includes('Skipped due to Binance cooldown')),
        ).length;
        const successful = Math.max(0, result.candidates.length - failed - skipped);
        const qualified = result.candidates.filter((c) => c.status === 'READY' && c.setup).length;

        return {
          successfulCount: successful,
          failedCount: failed,
          skippedCount: skipped,
          qualifiedCount: qualified,
          newSignals: persisted.created,
          deduplicatedSignals: Math.max(0, qualified - persisted.created),
          cooldownTripped: binanceRateLimiter.getStatus().state === 'OPEN',
        };
      },
      onProgress: async (progress) => {
        await saveScannerV2State({
          ...runningState,
          completedBatches: progress.completedBatches,
          activeWorkers: progress.activeWorkers,
          successfulCount: progress.successfulCount,
          failedCount: progress.failedCount,
          skippedCount: progress.skippedCount,
          qualifiedCount: progress.qualifiedCount,
          newSignals: progress.newSignals,
          coveragePercent: enabledSymbols.length > 0
            ? Number(((progress.successfulCount / enabledSymbols.length) * 100).toFixed(2))
            : 0,
          usedWeight1m: binanceRateLimiter.getStatus().usedWeight1m,
          cacheEntries: sharedCandleCache.size(),
        });
      },
    });

    // Independent lifecycle reconciliation using the same shared market snapshot
    if (binanceRateLimiter.getStatus().state !== 'OPEN') {
      await processSignalLifecycle(marketSnapshot).catch((err) => {
        console.warn('V2 lifecycle reconciliation notice:', err instanceof Error ? err.message : err);
      });
    }

    const cbEnd = binanceRateLimiter.getStatus();
    const nextScanAt = new Date(Date.now() + FULL_SCAN_INTERVAL_MS).toISOString();
    const finalState: ScannerV2PersistedState = {
      version: 'Hybrid Parallel V2',
      state: summary.state,
      cycleId: summary.cycleId,
      timeframe,
      concurrency: summary.concurrency,
      totalEligible: summary.totalEligible,
      totalBatches: summary.totalBatches,
      completedBatches: summary.completedBatches,
      activeWorkers: 0,
      successfulCount: summary.successfulCount,
      failedCount: summary.failedCount,
      skippedCount: summary.skippedCount,
      qualifiedCount: summary.qualifiedCount,
      newSignals: summary.newSignals,
      deduplicatedSignals: summary.deduplicatedSignals,
      coveragePercent: summary.coveragePercent,
      startedAt: summary.startedAt,
      lastSuccessfulScanAt: summary.successfulCount > 0 ? summary.completedAt : existing.lastSuccessfulScanAt,
      completedAt: summary.completedAt,
      durationMs: summary.durationMs,
      nextScanAt,
      usedWeight1m: cbEnd.usedWeight1m,
      weightLimit1m: cbEnd.weightLimit1m,
      cooldownUntil: cbEnd.cooldownUntil,
      cooldownReason: cbEnd.reason,
      standardStatus: cbEnd.state === 'OPEN' ? 'COOLDOWN' : 'ACTIVE',
      highRiskStatus: cbEnd.state === 'OPEN' ? 'COOLDOWN' : 'ACTIVE',
      cacheEntries: sharedCandleCache.size(),
    };

    await saveScannerV2State(finalState);
    return finalState;
  } catch (err) {
    const cbErr = binanceRateLimiter.getStatus();
    const isCooldown = err instanceof BinanceCooldownError || cbErr.state === 'OPEN';
    const errorState: ScannerV2PersistedState = {
      ...existing,
      version: 'Hybrid Parallel V2',
      state: isCooldown ? 'RATE_LIMIT_COOLDOWN' : 'ERROR',
      cycleId,
      timeframe,
      activeWorkers: 0,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      nextScanAt: new Date(Date.now() + FULL_SCAN_INTERVAL_MS).toISOString(),
      usedWeight1m: cbErr.usedWeight1m,
      weightLimit1m: cbErr.weightLimit1m,
      cooldownUntil: cbErr.cooldownUntil,
      cooldownReason: err instanceof Error ? err.message : cbErr.reason,
      standardStatus: isCooldown ? 'COOLDOWN' : 'ERROR',
      highRiskStatus: isCooldown ? 'COOLDOWN' : 'IDLE',
      cacheEntries: sharedCandleCache.size(),
    };
    await saveScannerV2State(errorState);
    return errorState;
  }
}

export function startFiveMinuteScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    if (activeCyclePromise) return; // Never overlap cycles
    if (binanceRateLimiter.getStatus().state === 'OPEN') return;
    void triggerCoordinatedV2Scan({ timeframe: '15m', deliverNotifications: true });
  }, FULL_SCAN_INTERVAL_MS);
}

export function stopFiveMinuteScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
