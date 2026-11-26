export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStatus {
  state: CircuitState;
  statusCode: number | null;
  reason: string | null;
  trippedAt: number | null;
  cooldownUntil: number | null;
  consecutiveTrips: number;
  usedWeight1m: number;
  weightLimit1m: number;
}

export class BinanceCooldownError extends Error {
  readonly statusCode: number;
  readonly cooldownUntil: number;
  readonly retryAfterMs: number;

  constructor(message: string, statusCode: number, cooldownUntil: number, now = Date.now()) {
    super(message);
    this.name = 'BinanceCooldownError';
    this.statusCode = statusCode;
    this.cooldownUntil = cooldownUntil;
    this.retryAfterMs = Math.max(0, cooldownUntil - now);
  }
}

export function parseRetryAfterMs(headerValue: string | null, now = Date.now()): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const diff = parsedDate - now;
    return diff > 0 ? diff : null;
  }
  return null;
}

const BINANCE_FUTURES_1M_HARD_LIMIT = 2400;
const BINANCE_FUTURES_1M_SAFE_BUDGET = 1200; // 50% safety margin

interface WeightEntry {
  timestamp: number;
  weight: number;
}

class BinanceRateLimitCoordinator {
  private state: CircuitState = 'CLOSED';
  private statusCode: number | null = null;
  private reason: string | null = null;
  private trippedAt: number | null = null;
  private cooldownUntil: number | null = null;
  private consecutiveTrips = 0;

  private weightWindow: WeightEntry[] = [];
  private remoteUsedWeight1m = 0;
  private remoteWeightUpdatedAt = 0;

  private inFlight = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { expiresAt: number; value: unknown }>();

  getStatus(now = Date.now()): CircuitBreakerStatus {
    if (this.state === 'OPEN' && this.cooldownUntil !== null && now >= this.cooldownUntil) {
      this.state = 'HALF_OPEN';
    }
    return {
      state: this.state,
      statusCode: this.statusCode,
      reason: this.reason,
      trippedAt: this.trippedAt,
      cooldownUntil: this.cooldownUntil,
      consecutiveTrips: this.consecutiveTrips,
      usedWeight1m: this.getCurrentUsedWeight(now),
      weightLimit1m: BINANCE_FUTURES_1M_SAFE_BUDGET,
    };
  }

  getCurrentUsedWeight(now = Date.now()): number {
    const cutoff = now - 60_000;
    this.weightWindow = this.weightWindow.filter((e) => e.timestamp > cutoff);
    const localWeight = this.weightWindow.reduce((sum, e) => sum + e.weight, 0);
    // Use remote header if it was updated within the last 60s and is higher
    if (now - this.remoteWeightUpdatedAt < 60_000) {
      return Math.max(localWeight, this.remoteUsedWeight1m);
    }
    return localWeight;
  }

  assertCanRequest(weight: number, now = Date.now()): void {
    const status = this.getStatus(now);
    if (status.state === 'OPEN' && status.cooldownUntil !== null) {
      const remainingSec = Math.ceil((status.cooldownUntil - now) / 1000);
      throw new BinanceCooldownError(
        `Binance API cooldown active (HTTP ${status.statusCode ?? 418}). Resuming in ${remainingSec}s (at ${new Date(status.cooldownUntil).toISOString()}).`,
        status.statusCode ?? 418,
        status.cooldownUntil,
        now,
      );
    }
    const used = this.getCurrentUsedWeight(now);
    if (used + weight > BINANCE_FUTURES_1M_SAFE_BUDGET) {
      const oldest = this.weightWindow[0]?.timestamp ?? now;
      const waitUntil = Math.max(now + 10_000, oldest + 60_000);
      throw new BinanceCooldownError(
        `Binance API 1-minute weight safety budget reached (${used}/${BINANCE_FUTURES_1M_SAFE_BUDGET}, Binance limit ${BINANCE_FUTURES_1M_HARD_LIMIT}). Deferring requests.`,
        429,
        waitUntil,
        now,
      );
    }
  }

  recordWeight(weight: number, now = Date.now()): void {
    this.weightWindow.push({ timestamp: now, weight });
  }

  recordResponseHeaders(headers: Headers | Record<string, string | undefined>, now = Date.now()): void {
    const getHeader = (name: string): string | null => {
      if (typeof (headers as Headers).get === 'function') {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string | undefined>;
      return record[name] ?? record[name.toLowerCase()] ?? null;
    };
    const usedHeader = getHeader('x-mbx-used-weight-1m') ?? getHeader('x-mbx-used-weight');
    if (usedHeader) {
      const parsed = Number(usedHeader);
      if (Number.isFinite(parsed) && parsed >= 0) {
        this.remoteUsedWeight1m = parsed;
        this.remoteWeightUpdatedAt = now;
      }
    }
  }

  recordSuccess(now = Date.now()): void {
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      this.statusCode = null;
      this.reason = null;
      this.trippedAt = null;
      this.cooldownUntil = null;
      this.consecutiveTrips = 0;
    }
    this.remoteWeightUpdatedAt = Math.max(this.remoteWeightUpdatedAt, now - 59_000);
  }

  trip(statusCode: number, retryAfterHeader: string | null, reason?: string, now = Date.now()): BinanceCooldownError {
    this.consecutiveTrips += 1;
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
    const isBan = statusCode === 418;
    const baseMs = isBan ? 180_000 : 60_000; // 3m for 418 IP ban, 1m for 429 rate limit
    const maxMs = 15 * 60_000; // cap at 15m
    const exponent = Math.min(4, this.consecutiveTrips - 1);
    const jitter = Math.floor(Math.random() * 5_000);
    const computedMs = Math.min(maxMs, baseMs * 2 ** exponent + jitter);
    const cooldownMs = retryAfterMs !== null ? Math.max(retryAfterMs, isBan ? 60_000 : 15_000) : computedMs;

    this.state = 'OPEN';
    this.statusCode = statusCode;
    this.trippedAt = now;
    this.cooldownUntil = now + cooldownMs;
    this.reason = reason ?? (isBan
      ? `Binance IP rate-limit ban (HTTP 418). Cooldown until ${new Date(this.cooldownUntil).toISOString()}.`
      : `Binance rate limit exceeded (HTTP 429). Cooldown until ${new Date(this.cooldownUntil).toISOString()}.`);

    return new BinanceCooldownError(this.reason, statusCode, this.cooldownUntil, now);
  }

  reset(): void {
    this.state = 'CLOSED';
    this.statusCode = null;
    this.reason = null;
    this.trippedAt = null;
    this.cooldownUntil = null;
    this.consecutiveTrips = 0;
    this.weightWindow = [];
    this.remoteUsedWeight1m = 0;
    this.remoteWeightUpdatedAt = 0;
    this.inFlight.clear();
    this.cache.clear();
  }

  getCached<T>(key: string, now = Date.now()): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  setCached<T>(key: string, value: T, ttlMs: number, now = Date.now()): void {
    // Keep cache bounded to 1500 entries
    if (this.cache.size >= 1500) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { expiresAt: now + ttlMs, value });
  }

  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

export const binanceRateLimiter = new BinanceRateLimitCoordinator();

/**
 * Wrapper around fetch for Binance Futures REST APIs with:
 * - Circuit breaker check before making any request
 * - Weight accounting & x-mbx-used-weight-1m tracking
 * - Immediate circuit trip on HTTP 418 or 429 honoring Retry-After
 */
export async function fetchBinanceRest(
  request: typeof fetch,
  url: string | URL,
  options: { weight: number; timeoutMs?: number; now?: number } = { weight: 2 },
): Promise<Response> {
  const now = options.now ?? Date.now();
  binanceRateLimiter.assertCanRequest(options.weight, now);
  binanceRateLimiter.recordWeight(options.weight, now);

  const response = await request(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    cache: 'no-store',
  });

  binanceRateLimiter.recordResponseHeaders(response.headers, Date.now());

  if (response.status === 418 || response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw binanceRateLimiter.trip(
      response.status,
      retryAfter,
      `Binance API ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      Date.now(),
    );
  }

  if (response.ok) {
    binanceRateLimiter.recordSuccess(Date.now());
  }

  return response;
}
