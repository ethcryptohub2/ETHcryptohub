export type CandleTimeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h';

export interface CachedCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type CandleFreshnessStatus =
  | 'FRESH_LIVE'
  | 'VALID_CACHED'
  | 'STALE'
  | 'MISSING'
  | 'COOLDOWN';

export interface CandleCacheAssessment {
  status: CandleFreshnessStatus;
  candles: CachedCandle[];
  lastUpdatedAt: number | null;
  ageMs: number | null;
  hasGaps: boolean;
  source: 'WS_INCREMENTAL' | 'REST_HISTORY' | 'NONE';
}

export const MINIMUM_INDICATOR_WARMUP = 210;
export const MAX_ROLLING_CANDLES = 420;
const MAX_CACHE_KEYS = 2500;

export function timeframeToMs(timeframe: CandleTimeframe): number {
  switch (timeframe) {
    case '1m': return 60_000;
    case '3m': return 3 * 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
  }
}

export function candleCacheKey(source: string, symbol: string, timeframe: CandleTimeframe): string {
  return `${source.toUpperCase()}:${symbol.toUpperCase()}:${timeframe}`;
}

export function detectCandleGaps(candles: readonly CachedCandle[], intervalMs: number): boolean {
  if (candles.length < 2) return false;
  // Check the most recent 50 candles for continuity gaps (> 1.5x interval)
  const startIdx = Math.max(1, candles.length - 50);
  for (let i = startIdx; i < candles.length; i += 1) {
    const diff = candles[i]!.openTime - candles[i - 1]!.openTime;
    if (diff <= 0 || diff > intervalMs * 1.5) {
      return true;
    }
  }
  return false;
}

interface CacheEntry {
  candles: CachedCandle[];
  lastUpdatedAt: number;
  lastWsUpdateAt: number | null;
  source: 'WS_INCREMENTAL' | 'REST_HISTORY';
}

export class RollingCandleCache {
  private store = new Map<string, CacheEntry>();

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  exportSnapshot(maxCandlesPerKey = 220): Array<{
    key: string;
    candles: CachedCandle[];
    lastUpdatedAt: number;
    lastWsUpdateAt: number | null;
    source: 'WS_INCREMENTAL' | 'REST_HISTORY';
  }> {
    const out: Array<{
      key: string;
      candles: CachedCandle[];
      lastUpdatedAt: number;
      lastWsUpdateAt: number | null;
      source: 'WS_INCREMENTAL' | 'REST_HISTORY';
    }> = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.candles.length === 0) continue;
      out.push({
        key,
        candles: entry.candles.slice(-maxCandlesPerKey),
        lastUpdatedAt: entry.lastUpdatedAt,
        lastWsUpdateAt: entry.lastWsUpdateAt,
        source: entry.source,
      });
    }
    return out;
  }

  importSnapshot(
    entries: ReadonlyArray<{
      key: string;
      candles: CachedCandle[];
      lastUpdatedAt: number;
      lastWsUpdateAt: number | null;
      source: 'WS_INCREMENTAL' | 'REST_HISTORY';
    }>,
  ): number {
    let imported = 0;
    for (const entry of entries) {
      if (!entry.key || !Array.isArray(entry.candles) || entry.candles.length === 0) continue;
      if (this.store.has(entry.key)) continue;
      this.evictIfNeeded();
      this.store.set(entry.key, {
        candles: entry.candles.slice(-MAX_ROLLING_CANDLES),
        lastUpdatedAt: entry.lastUpdatedAt,
        lastWsUpdateAt: entry.lastWsUpdateAt,
        source: entry.source,
      });
      imported += 1;
    }
    return imported;
  }

  private evictIfNeeded(): void {
    if (this.store.size < MAX_CACHE_KEYS) return;
    const oldestKey = this.store.keys().next().value;
    if (oldestKey !== undefined) this.store.delete(oldestKey);
  }

  setHistory(
    source: string,
    symbol: string,
    timeframe: CandleTimeframe,
    rawCandles: readonly CachedCandle[],
    now = Date.now(),
  ): CachedCandle[] {
    const key = candleCacheKey(source, symbol, timeframe);
    const deduped = new Map<number, CachedCandle>();
    for (const c of rawCandles) {
      if (
        Number.isFinite(c.openTime) &&
        Number.isFinite(c.closeTime) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.volume) &&
        c.high >= c.low &&
        c.close > 0
      ) {
        deduped.set(c.openTime, c);
      }
    }
    const sorted = [...deduped.values()]
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-MAX_ROLLING_CANDLES);

    if (sorted.length > 0) {
      this.evictIfNeeded();
      this.store.set(key, {
        candles: sorted,
        lastUpdatedAt: now,
        lastWsUpdateAt: this.store.get(key)?.lastWsUpdateAt ?? null,
        source: 'REST_HISTORY',
      });
    }
    return sorted;
  }

  upsertClosedCandle(
    source: string,
    symbol: string,
    timeframe: CandleTimeframe,
    candle: CachedCandle,
    now = Date.now(),
  ): boolean {
    const key = candleCacheKey(source, symbol, timeframe);
    const existing = this.store.get(key);
    if (!existing || existing.candles.length === 0) {
      return false; // Require initial history first before incremental WS updates
    }
    const last = existing.candles.at(-1)!;
    if (candle.openTime < last.openTime) {
      return false; // Ignore out-of-order stale candle
    }
    let nextCandles: CachedCandle[];
    if (candle.openTime === last.openTime) {
      nextCandles = [...existing.candles.slice(0, -1), candle];
    } else {
      nextCandles = [...existing.candles, candle].slice(-MAX_ROLLING_CANDLES);
    }
    this.store.set(key, {
      candles: nextCandles,
      lastUpdatedAt: now,
      lastWsUpdateAt: now,
      source: 'WS_INCREMENTAL',
    });
    return true;
  }

  assess(
    source: string,
    symbol: string,
    timeframe: CandleTimeframe,
    now = Date.now(),
    circuitBreakerOpen = false,
    minimumWarmup = MINIMUM_INDICATOR_WARMUP,
  ): CandleCacheAssessment {
    const key = candleCacheKey(source, symbol, timeframe);
    const entry = this.store.get(key);
    if (!entry || entry.candles.length === 0) {
      return {
        status: circuitBreakerOpen ? 'COOLDOWN' : 'MISSING',
        candles: [],
        lastUpdatedAt: null,
        ageMs: null,
        hasGaps: false,
        source: 'NONE',
      };
    }

    const intervalMs = timeframeToMs(timeframe);
    const ageMs = Math.max(0, now - entry.lastUpdatedAt);
    const hasGaps = detectCandleGaps(entry.candles, intervalMs);
    const latestCandle = entry.candles.at(-1)!;
    const candleLagMs = Math.max(0, now - latestCandle.closeTime);

    if (entry.candles.length < minimumWarmup) {
      return {
        status: circuitBreakerOpen ? 'COOLDOWN' : 'MISSING',
        candles: entry.candles,
        lastUpdatedAt: entry.lastUpdatedAt,
        ageMs,
        hasGaps,
        source: entry.source,
      };
    }

    // Stale if gaps exist or latest closed candle is older than 2x interval + 90s
    if (hasGaps || candleLagMs > intervalMs * 2 + 90_000) {
      return {
        status: 'STALE',
        candles: entry.candles,
        lastUpdatedAt: entry.lastUpdatedAt,
        ageMs,
        hasGaps,
        source: entry.source,
      };
    }

    const isLiveFresh =
      (entry.lastWsUpdateAt !== null && now - entry.lastWsUpdateAt <= intervalMs + 60_000) ||
      ageMs <= 90_000;

    return {
      status: isLiveFresh ? 'FRESH_LIVE' : 'VALID_CACHED',
      candles: entry.candles,
      lastUpdatedAt: entry.lastUpdatedAt,
      ageMs,
      hasGaps: false,
      source: entry.source,
    };
  }
}

const globalForCandleCache = globalThis as typeof globalThis & {
  __smartexitSharedCandleCache?: RollingCandleCache;
};
export const sharedCandleCache =
  globalForCandleCache.__smartexitSharedCandleCache ??= new RollingCandleCache();
