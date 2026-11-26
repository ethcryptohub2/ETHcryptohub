import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { binanceRateLimiter, BinanceCooldownError } from './binance-rate-limit';
import { ensureBinanceCooldownHydrated } from './binance-rate-limit-db';
import { sharedCandleCache } from './candle-cache';
import {
  analyzeHighRiskScalpingSetup,
  getHighRiskScalpingSettings,
  insertHighRiskSignal,
} from './high-risk-scalping';
import { pool } from './db';
import { getStoredMarketDataSettings, resolveCoinApiKey } from './market-data/settings';
import { syncProviderTrackersWithConfig, fetchCandlesWithFailover } from './market-data/provider-manager';
import { coinapiTracker } from './market-data/provider-registry';
import type { FuturesMarketSnapshot, FuturesMarketsProvider } from '../smartexit/apps/api/src/services/binance-futures-markets';
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
const SCANNER_V2_LOCK_KEY = 'scanner_v2_lock';
const LOCK_TTL_MS = 270_000; // 4.5m lease
const INSTANCE_OWNER_ID = randomUUID();

async function acquireGlobalV2Lock(now = Date.now()): Promise<boolean> {
  try {
    const res = await safeDbQuery<{ value_json: { ownerId: string; leaseUntil: number } }>(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value_json = EXCLUDED.value_json, updated_at = NOW()
       WHERE (public.app_settings.value_json->>'leaseUntil')::bigint < $3
          OR public.app_settings.value_json->>'ownerId' = $4
       RETURNING value_json`,
      [
        SCANNER_V2_LOCK_KEY,
        JSON.stringify({ ownerId: INSTANCE_OWNER_ID, leaseUntil: now + LOCK_TTL_MS }),
        now,
        INSTANCE_OWNER_ID,
      ],
    );
    return res.rows.length > 0;
  } catch {
    return true;
  }
}

async function releaseGlobalV2Lock(): Promise<void> {
  await safeDbQuery(
    `DELETE FROM public.app_settings
      WHERE key = $1 AND value_json->>'ownerId' = $2`,
    [SCANNER_V2_LOCK_KEY, INSTANCE_OWNER_ID],
  );
}

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
  const now = Date.now();
  const cb = await ensureBinanceCooldownHydrated(now);
  const mdSettings = await getStoredMarketDataSettings();
  const coinapiKey = resolveCoinApiKey(mdSettings);
  syncProviderTrackersWithConfig(
    {
      autoFailoverEnabled: mdSettings.autoFailoverEnabled,
      binanceEnabled: mdSettings.binanceEnabled,
      coinapiEnabled: mdSettings.coinapiEnabled,
      coinapiApiKey: coinapiKey,
      alternativeEnabled: mdSettings.alternativeEnabled,
      historicalCacheEnabled: mdSettings.historicalCacheEnabled,
    },
    now,
  );
  const hasBackupLiveProvider =
    mdSettings.autoFailoverEnabled &&
    mdSettings.coinapiEnabled &&
    Boolean(coinapiKey) &&
    coinapiTracker.isEligible(now);

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
  merged.cacheEntries = sharedCandleCache.size();

  if (cb.state === 'OPEN' && !hasBackupLiveProvider) {
    merged.state = 'RATE_LIMIT_COOLDOWN';
    merged.cooldownUntil = cb.cooldownUntil;
    merged.cooldownReason = 'Market data temporarily unavailable. Automatic recovery in progress.';
    merged.standardStatus = 'COOLDOWN';
    merged.highRiskStatus = 'COOLDOWN';
  } else {
    merged.cooldownUntil = null;
    merged.cooldownReason = null;
    if (merged.state === 'RATE_LIMIT_COOLDOWN') {
      merged.state = 'INITIALIZING';
      merged.standardStatus = 'IDLE';
      merged.highRiskStatus = 'IDLE';
    } else if (merged.state === 'COMPLETED' && merged.nextScanAt && Date.parse(merged.nextScanAt) > now) {
      merged.state = 'WAITING_FOR_NEXT_CYCLE';
    }
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
  const mdSettings = await getStoredMarketDataSettings();
  const coinapiKey = resolveCoinApiKey(mdSettings);
  syncProviderTrackersWithConfig(
    {
      autoFailoverEnabled: mdSettings.autoFailoverEnabled,
      binanceEnabled: mdSettings.binanceEnabled,
      coinapiEnabled: mdSettings.coinapiEnabled,
      coinapiApiKey: coinapiKey,
      alternativeEnabled: mdSettings.alternativeEnabled,
      historicalCacheEnabled: mdSettings.historicalCacheEnabled,
    },
    startedMs,
  );
  const hasBackupLiveProvider =
    mdSettings.autoFailoverEnabled &&
    mdSettings.coinapiEnabled &&
    Boolean(coinapiKey) &&
    coinapiTracker.isEligible(startedMs);

  if (cb.state === 'OPEN' && !hasBackupLiveProvider) {
    const cooldownState: ScannerV2PersistedState = {
      ...existing,
      version: 'Hybrid Parallel V2',
      state: 'RATE_LIMIT_COOLDOWN',
      timeframe,
      usedWeight1m: cb.usedWeight1m,
      weightLimit1m: cb.weightLimit1m,
      cooldownUntil: cb.cooldownUntil,
      cooldownReason: 'Market data temporarily unavailable. Automatic recovery in progress.',
      standardStatus: 'COOLDOWN',
      highRiskStatus: 'COOLDOWN',
      activeWorkers: 0,
    };
    await saveScannerV2State(cooldownState);
    return cooldownState;
  }

  const lockAcquired = await acquireGlobalV2Lock(startedMs);
  if (!lockAcquired) {
    return existing;
  }

  const failoverConfig = {
    autoFailoverEnabled: mdSettings.autoFailoverEnabled,
    binanceEnabled: mdSettings.binanceEnabled,
    coinapiEnabled: mdSettings.coinapiEnabled,
    coinapiApiKey: coinapiKey,
    alternativeEnabled: mdSettings.alternativeEnabled,
    historicalCacheEnabled: mdSettings.historicalCacheEnabled,
  };

  try {
    const useFailoverMode = cb.state === 'OPEN' && hasBackupLiveProvider;

    if (!useFailoverMode) {
      const syncState = await getScannerSyncState();
      const lastAttempt = syncState?.last_attempt_at ? Date.parse(syncState.last_attempt_at) : 0;
      if (!lastAttempt || Date.now() - lastAttempt >= 15 * 60_000) {
        await syncBinanceScannerUniverse(null).catch((err) => {
          if (err instanceof BinanceCooldownError) throw err;
        });
      }
    }

    const enabledSymbols = await getEnabledScannerSymbols();
    const settings = await getNotificationSystemSettings();
    const highRiskSettings = await getHighRiskScalpingSettings().catch(() => null);
    const researchProvider = await loadMarketResearchProvider();

    if (!useFailoverMode && binanceRateLimiter.getStatus().state !== 'OPEN') {
      binanceWsKlineEngine.start(enabledSymbols.slice(0, 180), timeframe);
    }

    let marketSnapshot: FuturesMarketSnapshot;
    if (!useFailoverMode) {
      marketSnapshot = await markets.list().catch((err: unknown) => {
        if (err instanceof BinanceCooldownError) throw err;
        if (err instanceof BinanceMarketDataError) {
          throw new Error('Market data acquisition failed.');
        }
        throw err;
      });
    } else {
      // Backup live provider mode (CoinAPI): build snapshot from fetched candles without hitting Binance
      marketSnapshot = {
        exchange: 'BINANCE',
        market: 'USDⓈ-M FUTURES',
        source: 'COINAPI_BINANCEFTS_FAILOVER',
        updatedAt: new Date().toISOString(),
        symbols: [],
      };
    }

    const PRIORITY_CORE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'SUIUSDT', 'APTUSDT', 'NEARUSDT', 'ARBUSDT', 'OPUSDT', 'LTCUSDT'];
    const orderedSymbols = useFailoverMode
      ? [
          ...PRIORITY_CORE.filter((s) => enabledSymbols.includes(s)),
          ...enabledSymbols.filter((s) => !PRIORITY_CORE.includes(s)),
        ]
      : enabledSymbols;
    const maxSymbolsThisCycle = useFailoverMode ? 16 : orderedSymbols.length;
    let failoverUsedCount = 0;

    const btcMarket = marketSnapshot.symbols.find((m) => m.symbol === 'BTCUSDT');
    const btcDirection = !btcMarket?.priceChangePercent24h
      ? ('NEUTRAL' as const)
      : btcMarket.priceChangePercent24h > 0.2
        ? ('BULLISH' as const)
        : btcMarket.priceChangePercent24h < -0.2
          ? ('BEARISH' as const)
          : ('NEUTRAL' as const);

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
      cooldownUntil: null,
      cooldownReason: null,
      standardStatus: 'ACTIVE',
      highRiskStatus: highRiskSettings?.enabled ? 'ACTIVE' : 'DISABLED',
    };
    await saveScannerV2State(runningState);

    const summary = await runHybridParallelWorkPool({
      cycleId,
      symbols: orderedSymbols,
      batchSize: options.batchSize ?? DEFAULT_V2_BATCH_SIZE,
      concurrency: options.concurrency ?? DEFAULT_V2_CONCURRENCY,
      allowFailoverMode: useFailoverMode,
      signal: options.signal,
      processBatch: async (batchSymbols) => {
        let activeBatchSymbols = batchSymbols;
        let preSkipped = 0;
        if (useFailoverMode) {
          const remainingBudget = Math.max(0, maxSymbolsThisCycle - failoverUsedCount);
          if (remainingBudget === 0 || !coinapiTracker.isEligible()) {
            return {
              successfulCount: 0,
              failedCount: 0,
              skippedCount: batchSymbols.length,
              qualifiedCount: 0,
              newSignals: 0,
              deduplicatedSignals: 0,
            };
          }
          activeBatchSymbols = batchSymbols.slice(0, remainingBudget);
          preSkipped = batchSymbols.length - activeBatchSymbols.length;
          failoverUsedCount += activeBatchSymbols.length;

          // Fetch CoinAPI candles for activeBatchSymbols and build snapshot entries
          for (const sym of activeBatchSymbols) {
            try {
              const res = await fetchCandlesWithFailover({
                symbol: sym,
                timeframe,
                limit: 250,
                config: failoverConfig,
              });
              const latest = res.candles.at(-1);
              if (latest) {
                const bars24h = res.candles.slice(-96);
                const first24h = bars24h[0];
                const quoteVol = bars24h.reduce((sum, c) => sum + c.volume * c.close, 0);
                const pct = first24h && first24h.open > 0 ? ((latest.close - first24h.open) / first24h.open) * 100 : 0;
                marketSnapshot.symbols.push({
                  symbol: sym,
                  contractType: 'PERPETUAL',
                  baseAsset: sym.replace(/USDT$/, ''),
                  quoteAsset: 'USDT',
                  lastPrice: latest.close,
                  priceChangePercent24h: pct,
                  quoteVolume24h: quoteVol,
                  tradeCount24h: bars24h.length,
                });
              }
            } catch {
              // Individual symbol error handled by scannerService as DATA_UNAVAILABLE
            }
          }
        }

        const batchMarketsProvider: FuturesMarketsProvider = useFailoverMode
          ? { list: async () => marketSnapshot }
          : markets;
        const batchScanner = new BinanceMarketScannerService(
          batchMarketsProvider,
          globalThis.fetch,
          Date.now,
          researchProvider,
          useFailoverMode
            ? async (sym, tf) => {
                const assessed = sharedCandleCache.assess('BINANCE', sym, tf, Date.now(), false);
                if (assessed.candles.length > 0) return assessed.candles;
                throw new Error('Market candle unavailable from failover provider.');
              }
            : undefined,
        );

        const result = await batchScanner.scan({
          quoteAsset: 'USDT',
          timeframe,
          symbols: activeBatchSymbols,
          minimumVolume: 5_000_000,
          limit: activeBatchSymbols.length,
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

        // Shared-cache High-Risk Strategy evaluation (zero extra REST candle requests)
        let hrCreated = 0;
        if (
          highRiskSettings?.enabled &&
          (timeframe === '5m' || timeframe === '15m') &&
          highRiskSettings.enabledTimeframes.includes(timeframe)
        ) {
          const client = await pool().connect().catch(() => null);
          if (client) {
            try {
              for (const sym of batchSymbols) {
                const mkt = marketSnapshot.symbols.find((m) => m.symbol === sym);
                if (!mkt?.lastPrice || mkt.quoteVolume24h < highRiskSettings.minimumQuoteVolume) continue;
                const assessed = sharedCandleCache.assess('BINANCE', sym, timeframe, Date.now(), false);
                if (assessed.status !== 'FRESH_LIVE' && assessed.status !== 'VALID_CACHED') continue;
                const setup = analyzeHighRiskScalpingSetup({
                  symbol: sym,
                  timeframe,
                  candles: assessed.candles,
                  price: mkt.lastPrice,
                  btcDirection,
                  settings: highRiskSettings,
                  now: Date.now(),
                });
                if (!setup) continue;
                await client.query('BEGIN');
                const hrRes = await insertHighRiskSignal(client, setup, highRiskSettings);
                await client.query('COMMIT');
                if (hrRes) hrCreated += 1;
              }
            } catch {
              await client.query('ROLLBACK').catch(() => {});
            } finally {
              client.release();
            }
          }
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
          skippedCount: skipped + preSkipped,
          qualifiedCount: qualified + hrCreated,
          newSignals: persisted.created + hrCreated,
          deduplicatedSignals: Math.max(0, qualified - persisted.created),
          cooldownTripped: !useFailoverMode && binanceRateLimiter.getStatus().state === 'OPEN',
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
    const globalCooldown = !useFailoverMode && cbEnd.state === 'OPEN';
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
      cooldownUntil: globalCooldown ? cbEnd.cooldownUntil : null,
      cooldownReason: globalCooldown ? 'Market data temporarily unavailable. Automatic recovery in progress.' : null,
      standardStatus: globalCooldown ? 'COOLDOWN' : 'ACTIVE',
      highRiskStatus: globalCooldown ? 'COOLDOWN' : (highRiskSettings?.enabled ? 'ACTIVE' : 'DISABLED'),
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
      cooldownReason: 'Market data temporarily unavailable. Automatic recovery in progress.',
      standardStatus: isCooldown ? 'COOLDOWN' : 'ERROR',
      highRiskStatus: isCooldown ? 'COOLDOWN' : 'IDLE',
      cacheEntries: sharedCandleCache.size(),
    };
    await saveScannerV2State(errorState);
    return errorState;
  } finally {
    await releaseGlobalV2Lock();
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
