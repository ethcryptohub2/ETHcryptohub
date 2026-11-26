import { binanceRateLimiter, BinanceCooldownError } from '../binance-rate-limit';
import { sharedCandleCache, timeframeToMs } from '../candle-cache';
import {
  binanceTracker,
  binanceVisionTracker,
  coinapiTracker,
  cryptoDataDownloadTracker,
  getAllProviderHealthSnapshots,
} from './provider-registry';
import { fetchBinanceCandles, discoverBinanceInstruments } from './providers/binance';
import { fetchCoinApiCandles, discoverCoinApiInstruments } from './providers/coinapi';
import { fetchCryptoDataDownloadHistoricalCandles } from './providers/cryptodatadownload';
import { fetchBinanceVisionDailyArchive } from './providers/binance-vision';
import type {
  FailoverCandleResponse,
  MarketDataProviderId,
  NormalizedCandle,
  NormalizedInstrument,
  ProviderHealthSnapshot,
  ProviderTimeframe,
} from './provider-types';

export class AllMarketDataProvidersUnavailableError extends Error {
  readonly cooldownUntil: number | null;
  constructor(cooldownUntil: number | null = null) {
    super('Market data temporarily unavailable. Automatic recovery in progress.');
    this.name = 'AllMarketDataProvidersUnavailableError';
    this.cooldownUntil = cooldownUntil;
  }
}

export interface ProviderFailoverConfig {
  autoFailoverEnabled: boolean;
  binanceEnabled: boolean;
  coinapiEnabled: boolean;
  coinapiApiKey: string | null;
  alternativeEnabled: boolean;
  historicalCacheEnabled: boolean;
}

function getStatusCode(err: unknown): number | null {
  if (err && typeof err === 'object') {
    if ('statusCode' in err && typeof (err as { statusCode?: unknown }).statusCode === 'number') {
      return (err as { statusCode: number }).statusCode;
    }
  }
  return null;
}

export function syncProviderTrackersWithConfig(config: ProviderFailoverConfig, now = Date.now()): void {
  const cb = binanceRateLimiter.getStatus(now);
  binanceTracker.setAvailability(config.binanceEnabled, true);
  if (cb.state === 'OPEN') {
    binanceTracker.syncExternalCooldown('OPEN', cb.cooldownUntil, cb.reason);
  }
  coinapiTracker.setAvailability(config.coinapiEnabled, Boolean(config.coinapiApiKey));
  cryptoDataDownloadTracker.setAvailability(config.alternativeEnabled, true);
  binanceVisionTracker.setAvailability(config.historicalCacheEnabled, true);
}

export function validateCandleSeriesFreshness(
  candles: readonly NormalizedCandle[],
  timeframe: ProviderTimeframe,
  now = Date.now(),
): { valid: boolean; reason: string | null } {
  if (candles.length === 0) return { valid: false, reason: 'Empty candle series' };
  const intervalMs = timeframeToMs(timeframe);
  const latest = candles.at(-1)!;
  const lagMs = Math.max(0, now - latest.closeTime);
  if (lagMs > intervalMs * 3 + 120_000) {
    return { valid: false, reason: `Stale candle series (lag ${Math.round(lagMs / 1000)}s)` };
  }
  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i]!.openTime <= candles[i - 1]!.openTime) {
      return { valid: false, reason: 'Out-of-order candle timestamps' };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Fetches normalized Binance USD-M Futures candles using automatic multi-provider failover:
 * Priority: 1. Binance Official -> 2. CoinAPI (BINANCEFTS) -> 3. Verified Alternative (if live-eligible)
 */
export async function fetchCandlesWithFailover(options: {
  symbol: string;
  timeframe: ProviderTimeframe;
  limit?: number;
  config: ProviderFailoverConfig;
  request?: typeof fetch;
  now?: number;
}): Promise<FailoverCandleResponse> {
  const now = options.now ?? Date.now();
  const request = options.request ?? globalThis.fetch;
  const limit = options.limit ?? 400;
  syncProviderTrackersWithConfig(options.config, now);

  const priorityOrder: MarketDataProviderId[] = options.config.autoFailoverEnabled
    ? ['binance', 'coinapi', 'cryptodatadownload']
    : ['binance'];

  let earliestCooldown: number | null = null;

  for (const providerId of priorityOrder) {
    if (providerId === 'binance') {
      const cb = binanceRateLimiter.getStatus(now);
      if (!options.config.binanceEnabled || cb.state === 'OPEN' || !binanceTracker.isEligible(now)) {
        if (cb.cooldownUntil) earliestCooldown = cb.cooldownUntil;
        continue;
      }
      try {
        const candles = await fetchBinanceCandles(options.symbol, options.timeframe, limit, request);
        const check = validateCandleSeriesFreshness(candles, options.timeframe, now);
        if (!check.valid) {
          binanceTracker.recordFailure(null, check.reason ?? 'Invalid candle series', null, now);
          continue;
        }
        binanceTracker.recordSuccess(now);
        sharedCandleCache.setHistory('BINANCE', options.symbol, options.timeframe, candles, now);
        return { candles, provider: 'binance', historicalOnly: false, isFresh: true, fetchedAt: now };
      } catch (err) {
        if (err instanceof BinanceCooldownError) {
          binanceTracker.syncExternalCooldown('OPEN', err.cooldownUntil, err.message);
          earliestCooldown = err.cooldownUntil;
          console.warn(`[MarketDataFailover] Binance cooldown (${err.statusCode}); failing over from ${options.symbol}.`);
        } else {
          const status = getStatusCode(err);
          const rec = binanceTracker.recordFailure(status, err instanceof Error ? err.message : 'Binance fetch failed', null, now);
          if (rec.cooldownUntil) earliestCooldown = rec.cooldownUntil;
          console.warn(`[MarketDataFailover] Binance error on ${options.symbol}: ${rec.message}`);
        }
        continue;
      }
    }

    if (providerId === 'coinapi') {
      if (!options.config.coinapiEnabled || !options.config.coinapiApiKey || !coinapiTracker.isEligible(now)) {
        continue;
      }
      try {
        coinapiTracker.recordQuotaUse(1, now);
        const candles = await fetchCoinApiCandles(
          options.symbol,
          options.timeframe,
          options.config.coinapiApiKey,
          limit,
          request,
        );
        const check = validateCandleSeriesFreshness(candles, options.timeframe, now);
        if (!check.valid) {
          coinapiTracker.recordFailure(null, check.reason ?? 'CoinAPI stale series', null, now);
          continue;
        }
        coinapiTracker.recordSuccess(now);
        sharedCandleCache.setHistory('BINANCE', options.symbol, options.timeframe, candles, now);
        console.info(`[MarketDataFailover] Served ${options.symbol} ${options.timeframe} via CoinAPI BINANCEFTS.`);
        return { candles, provider: 'coinapi', historicalOnly: false, isFresh: true, fetchedAt: now };
      } catch (err) {
        const status = getStatusCode(err);
        const rec = coinapiTracker.recordFailure(status, err instanceof Error ? err.message : 'CoinAPI error', null, now);
        if (rec.cooldownUntil && (!earliestCooldown || rec.cooldownUntil < earliestCooldown)) {
          earliestCooldown = rec.cooldownUntil;
        }
        console.warn(`[MarketDataFailover] CoinAPI fallback failed for ${options.symbol}: ${rec.message}`);
        continue;
      }
    }

    if (providerId === 'cryptodatadownload') {
      // Strictly reject historical-only provider for live signal generation
      if (!options.config.alternativeEnabled || cryptoDataDownloadTracker.capabilities.historicalOnly) {
        continue;
      }
      try {
        const candles = await fetchCryptoDataDownloadHistoricalCandles(options.symbol, options.timeframe, request);
        return { candles, provider: 'cryptodatadownload', historicalOnly: true, isFresh: false, fetchedAt: now };
      } catch (err) {
        cryptoDataDownloadTracker.recordFailure(getStatusCode(err), err instanceof Error ? err.message : 'CDD error', null, now);
      }
    }
  }

  throw new AllMarketDataProvidersUnavailableError(earliestCooldown);
}

/**
 * Bootstraps the rolling candle cache using Binance Vision daily historical archives.
 * Strictly historical-only; never classified as fresh live data.
 */
export async function bootstrapHistoryFromBinanceVision(options: {
  symbol: string;
  timeframe: ProviderTimeframe;
  dateStr: string;
  request?: typeof fetch;
  now?: number;
}): Promise<NormalizedCandle[]> {
  const now = options.now ?? Date.now();
  const candles = await fetchBinanceVisionDailyArchive(
    options.symbol,
    options.timeframe,
    options.dateStr,
    options.request ?? globalThis.fetch,
  );
  if (candles.length > 0) {
    binanceVisionTracker.recordSuccess(now);
    sharedCandleCache.setHistory('BINANCE', options.symbol, options.timeframe, candles, now);
  }
  return candles;
}

export async function discoverInstrumentsWithFailover(options: {
  config: ProviderFailoverConfig;
  request?: typeof fetch;
  now?: number;
}): Promise<{ instruments: NormalizedInstrument[]; provider: MarketDataProviderId }> {
  const now = options.now ?? Date.now();
  const request = options.request ?? globalThis.fetch;
  syncProviderTrackersWithConfig(options.config, now);

  if (options.config.binanceEnabled && binanceTracker.isEligible(now) && binanceRateLimiter.getStatus(now).state !== 'OPEN') {
    try {
      const instruments = await discoverBinanceInstruments(request);
      binanceTracker.recordSuccess(now);
      return { instruments, provider: 'binance' };
    } catch (err) {
      if (err instanceof BinanceCooldownError) {
        binanceTracker.syncExternalCooldown('OPEN', err.cooldownUntil, err.message);
      } else {
        binanceTracker.recordFailure(getStatusCode(err), err instanceof Error ? err.message : 'Binance discovery error', null, now);
      }
    }
  }

  if (
    options.config.autoFailoverEnabled &&
    options.config.coinapiEnabled &&
    options.config.coinapiApiKey &&
    coinapiTracker.isEligible(now)
  ) {
    try {
      coinapiTracker.recordQuotaUse(1, now);
      const instruments = await discoverCoinApiInstruments(options.config.coinapiApiKey, request);
      coinapiTracker.recordSuccess(now);
      return { instruments, provider: 'coinapi' };
    } catch (err) {
      coinapiTracker.recordFailure(getStatusCode(err), err instanceof Error ? err.message : 'CoinAPI discovery error', null, now);
    }
  }

  throw new AllMarketDataProvidersUnavailableError(binanceRateLimiter.getStatus(now).cooldownUntil);
}

export function getProviderDiagnosticsForAdmin(now = Date.now()): ProviderHealthSnapshot[] {
  return getAllProviderHealthSnapshots(now);
}
