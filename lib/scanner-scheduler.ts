import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { QueryResultRow } from 'pg';
import { tradingExecutionGate } from './binance-futures';
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
export const DEFAULT_V2_CONCURRENCY = 2; // Bounded concurrency for 0.2 vCPU Northflank runtime

export function isBackgroundScannerEnabled(): boolean {
  return process.env.VERCEL !== '1' && process.env.DISABLE_BACKGROUND_SCANNER !== 'true';
}
const SCANNER_V2_STATE_KEY = 'scanner_v2_state';
const SCANNER_V2_LOCK_KEY = 'scanner_v2_lock';
const COINAPI_QUOTA_KEY = 'coinapi_daily_quota';
const CANDLE_CACHE_SNAPSHOT_KEY = 'scanner_candle_cache_snapshot';
const LOCK_TTL_MS = 480_000; // 8m lease for full cold-start warmups
const AUTOMATION_TICK_INTERVAL_MS = 45_000;
const globalForScheduler = globalThis as typeof globalThis & {
  __smartexitInstanceOwnerId?: string;
  __smartexitActiveCyclePromise?: Promise<ScannerV2PersistedState> | null;
  __smartexitSchedulerTimer?: ReturnType<typeof setInterval> | null;
  __smartexitAutomationTimer?: ReturnType<typeof setInterval> | null;
  __smartexitAutomationBusy?: boolean;
  __smartexitAutomationTickCount?: number;
  __smartexitAutomationFailures?: number;
  __smartexitAutomationLastError?: string | null;
  __smartexitAutomationSignalsBound?: boolean;
};
const INSTANCE_OWNER_ID = globalForScheduler.__smartexitInstanceOwnerId ??= randomUUID();

async function hydrateCoinApiQuotaFromDb(): Promise<void> {
  const res = await safeDbQuery<{ value_json: { dailyUsed?: number; dailyWindowStart?: number } }>(
    `SELECT value_json FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [COINAPI_QUOTA_KEY],
  );
  const row = res.rows[0]?.value_json;
  if (row && typeof row.dailyUsed === 'number' && typeof row.dailyWindowStart === 'number') {
    coinapiTracker.hydrateQuotaState(row.dailyUsed, row.dailyWindowStart);
  }
}

async function persistCoinApiQuotaToDb(): Promise<void> {
  const state = coinapiTracker.exportQuotaState();
  await safeDbQuery(
    `INSERT INTO public.app_settings (key, value_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [COINAPI_QUOTA_KEY, JSON.stringify(state)],
  );
}

async function hydrateCandleCacheFromDb(): Promise<number> {
  if (sharedCandleCache.size() > 0) return 0;
  const res = await safeDbQuery<{ value_json: { gzipBase64?: string } }>(
    `SELECT value_json FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [CANDLE_CACHE_SNAPSHOT_KEY],
  );
  const b64 = res.rows[0]?.value_json?.gzipBase64;
  if (!b64) return 0;
  try {
    const json = gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    const entries = JSON.parse(json);
    return Array.isArray(entries) ? sharedCandleCache.importSnapshot(entries) : 0;
  } catch {
    return 0;
  }
}

async function persistCandleCacheToDb(): Promise<void> {
  const entries = sharedCandleCache.exportSnapshot(220);
  if (entries.length === 0) return;
  try {
    const gzipBase64 = gzipSync(Buffer.from(JSON.stringify(entries), 'utf8')).toString('base64');
    await safeDbQuery(
      `INSERT INTO public.app_settings (key, value_json, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
      [CANDLE_CACHE_SNAPSHOT_KEY, JSON.stringify({ gzipBase64, entries: entries.length, savedAt: new Date().toISOString() })],
    );
  } catch {
    // Non-fatal persistence warning
  }
}

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
  await hydrateCoinApiQuotaFromDb();
  if (sharedCandleCache.size() === 0) {
    await hydrateCandleCacheFromDb();
  }
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
  if (globalForScheduler.__smartexitActiveCyclePromise) {
    const state = await globalForScheduler.__smartexitActiveCyclePromise;
    return { state, deduplicated: true };
  }

  const runPromise = executeCoordinatedV2Cycle(options);
  globalForScheduler.__smartexitActiveCyclePromise = runPromise;
  try {
    const state = await runPromise;
    return { state, deduplicated: false };
  } finally {
    if (globalForScheduler.__smartexitActiveCyclePromise === runPromise) {
      globalForScheduler.__smartexitActiveCyclePromise = null;
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
  await hydrateCoinApiQuotaFromDb();
  await hydrateCandleCacheFromDb();
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
      binanceWsKlineEngine.start(enabledSymbols, timeframe);
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
    const createdSignalIds: string[] = [];

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
        for (const id of persisted.createdSignalIds) {
          createdSignalIds.push(id);
        }
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
                if (hrRes) {
                  hrCreated += 1;
                  createdSignalIds.push(hrRes.centralId);
                }
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
        const failedFromCandidates = result.candidates.filter((c) =>
          c.status === 'DATA_UNAVAILABLE' && !c.warnings.some((w) => w.includes('Skipped due to Binance cooldown')),
        ).length;
        const evaluatedSymbols = new Set(result.candidates.map((c) => c.symbol));
        const missingFailoverCount = useFailoverMode
          ? activeBatchSymbols.filter((s) => !evaluatedSymbols.has(s)).length
          : 0;
        const failed = failedFromCandidates + missingFailoverCount;
        const successful = Math.max(0, result.candidates.length - failedFromCandidates - skipped);
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
        await acquireGlobalV2Lock().catch(() => false);
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

    // Immediate automatic Demo order dispatch for newly generated signals when enabled on backend
    if (
      isBackgroundScannerEnabled() &&
      process.env.WORKER_SAFE_MODE !== 'true' &&
      process.env.DEMO_ORDER_DISPATCH_ENABLED === 'true' &&
      createdSignalIds.length > 0 &&
      tradingExecutionGate('DEMO')
    ) {
      try {
        const { processNewAutomaticTrades } = await import('./trading-execution');
        await processNewAutomaticTrades(createdSignalIds);
      } catch (err) {
        console.warn('[V2 Auto-Execution] Post-scan Demo dispatch warning:', err instanceof Error ? err.message : err);
      }
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
    if (useFailoverMode) {
      await persistCoinApiQuotaToDb();
    }
    if (sharedCandleCache.size() > 0) {
      await persistCandleCacheToDb();
    }
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
  if (!isBackgroundScannerEnabled()) return;
  if (globalForScheduler.__smartexitSchedulerTimer) return;
  globalForScheduler.__smartexitSchedulerTimer = setInterval(() => {
    if (globalForScheduler.__smartexitActiveCyclePromise) return; // Never overlap cycles
    if (binanceRateLimiter.getStatus().state === 'OPEN') return;
    void triggerCoordinatedV2Scan({ timeframe: '15m', deliverNotifications: true });
  }, FULL_SCAN_INTERVAL_MS);
}

export function stopFiveMinuteScheduler(): void {
  if (globalForScheduler.__smartexitSchedulerTimer) {
    clearInterval(globalForScheduler.__smartexitSchedulerTimer);
    globalForScheduler.__smartexitSchedulerTimer = null;
  }
}

async function runDemoAutomationTick(workerId: string): Promise<void> {
  if (!isBackgroundScannerEnabled() || globalForScheduler.__smartexitAutomationBusy) return;
  globalForScheduler.__smartexitAutomationBusy = true;
  const safeMode =
    process.env.WORKER_SAFE_MODE === 'true' ||
    process.env.DEMO_ORDER_DISPATCH_ENABLED !== 'true' ||
    !tradingExecutionGate('DEMO');
  const nextTick = (globalForScheduler.__smartexitAutomationTickCount ?? 0) + 1;
  globalForScheduler.__smartexitAutomationTickCount = nextTick;
  let protectionFailures = 0;

  try {
    const { acquireWorkerLease, renewWorkerLease, releaseWorkerLease } = await import('./worker-lease');
    const hostname = os.hostname() || 'northflank-container';

    if (!globalForScheduler.__smartexitAutomationSignalsBound) {
      globalForScheduler.__smartexitAutomationSignalsBound = true;
      const onExit = () => {
        stopDemoAutomationLoop();
        void releaseWorkerLease(workerId).catch(() => {});
      };
      process.once('SIGTERM', onExit);
      process.once('SIGINT', onExit);
    }

    const leaseAttempt = await acquireWorkerLease({
      workerId,
      hostname,
      pid: process.pid,
      version: '2.1.0-northflank',
      environment: 'DEMO',
      ttlSeconds: 120,
      safeMode,
    });
    if (!leaseAttempt.ok) {
      return;
    }

    if (!safeMode) {
      const { reconcileBinanceDemoProtection, processNewAutomaticTrades } = await import('./trading-execution');
      const reconciled = await reconcileBinanceDemoProtection(10).catch((err) => {
        console.warn('[Automation] Demo protection reconciliation error:', err instanceof Error ? err.message : err);
        return null;
      });
      if (reconciled && Array.isArray(reconciled.results)) {
        protectionFailures = reconciled.results.filter(
          (r) => r.status === 'FAILED' || r.status === 'PROTECTION_FAILED',
        ).length;
      }
      await processNewAutomaticTrades([]).catch((err) => {
        console.warn('[Automation] Demo signal dispatch error:', err instanceof Error ? err.message : err);
      });
    }

    const v2 = await getScannerV2State().catch(() => null);
    let totalTradesExecuted = 0;
    try {
      const { query } = await import('./db');
      const countRes = await query<{ cnt: string }>(
        `SELECT COUNT(*)::TEXT AS cnt FROM public.trade_executions WHERE environment = 'DEMO' AND execution_status IN ('PROTECTED', 'CLOSED', 'ENTRY_FILLED')`,
      );
      totalTradesExecuted = Number(countRes.rows[0]?.cnt ?? 0);
    } catch {}

    globalForScheduler.__smartexitAutomationFailures = 0;
    globalForScheduler.__smartexitAutomationLastError = null;
    await renewWorkerLease({
      workerId,
      tickCount: nextTick,
      activeCycle: v2?.cycleId ?? 'V2-RUNTIME',
      batchProgress: v2 ? `${v2.completedBatches}/${v2.totalBatches}` : '0/0',
      scannedPairsCount: v2?.successfulCount ?? 0,
      lastSuccessfulScanAt: v2?.lastSuccessfulScanAt ?? null,
      lastScanDurationMs: v2?.durationMs ?? undefined,
      lastCandidateCount: v2?.totalEligible ?? 0,
      lastQualifiedCount: v2?.qualifiedCount ?? 0,
      totalTradesExecuted,
      exchangeExecutionStatus: safeMode ? 'SAFE_MODE (READ_ONLY)' : 'DEMO_DISPATCH_ENABLED',
      protectionFailures,
      emergencyStopStatus: 'CLEAR',
      consecutiveFailures: 0,
      lastError: null,
      safeMode,
      ttlSeconds: 120,
    });
  } catch (err) {
    const failures = (globalForScheduler.__smartexitAutomationFailures ?? 0) + 1;
    globalForScheduler.__smartexitAutomationFailures = failures;
    const msg = err instanceof Error ? err.message.slice(0, 240) : 'Automation tick error';
    globalForScheduler.__smartexitAutomationLastError = msg;
    const { renewWorkerLease } = await import('./worker-lease').catch(() => ({ renewWorkerLease: null }));
    if (renewWorkerLease) {
      await renewWorkerLease({
        workerId,
        tickCount: nextTick,
        exchangeExecutionStatus: safeMode ? 'SAFE_MODE (READ_ONLY)' : 'DEGRADED',
        protectionFailures,
        consecutiveFailures: failures,
        lastError: msg,
        safeMode,
        ttlSeconds: 120,
      }).catch(() => {});
    }
  } finally {
    globalForScheduler.__smartexitAutomationBusy = false;
  }
}

export function startDemoAutomationLoop(): void {
  if (!isBackgroundScannerEnabled()) return;
  if (globalForScheduler.__smartexitAutomationTimer) return;
  const workerId = `northflank-${os.hostname() || 'worker'}-${INSTANCE_OWNER_ID.slice(0, 8)}`;
  setTimeout(() => {
    void runDemoAutomationTick(workerId);
  }, 5_000);
  globalForScheduler.__smartexitAutomationTimer = setInterval(() => {
    void runDemoAutomationTick(workerId);
  }, AUTOMATION_TICK_INTERVAL_MS);
}

export function stopDemoAutomationLoop(): void {
  if (globalForScheduler.__smartexitAutomationTimer) {
    clearInterval(globalForScheduler.__smartexitAutomationTimer);
    globalForScheduler.__smartexitAutomationTimer = null;
  }
}
