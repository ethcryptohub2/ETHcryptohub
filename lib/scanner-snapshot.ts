import type { MarketScannerCandidate } from '../smartexit/apps/api/src/services/market-scanner';

function timestampIsRecent(time: number, maxAgeSeconds: number, now: number): boolean {
  return Number.isFinite(time) && time <= now && now - time <= maxAgeSeconds * 1000;
}

export function savedScannerCacheStatus(savedCount: number, updatedAt: string | null, maxAgeSeconds: number, now: number) {
  if (!savedCount) return 'NO_SAVED_RESULTS';
  return timestampIsRecent(Date.parse(updatedAt ?? ''), maxAgeSeconds, now) ? 'RECENT_CACHE' : 'STALE_CACHE';
}

// Reading a saved scan never refreshes its market data or makes it actionable.
export function savedScannerCandidate(
  saved: MarketScannerCandidate,
  scannedAt: string,
  maxAgeSeconds: number,
  now: number,
): MarketScannerCandidate {
  const scanned = new Date(scannedAt).getTime();
  const candle = Date.parse(saved.lastCandleCloseAt ?? '');
  const candidate = { ...saved, scannedAt: Number.isFinite(scanned) ? new Date(scanned).toISOString() : undefined };
  const usablePrice = saved.price !== null && Number.isFinite(saved.price) && saved.price > 0;
  const unavailable = saved.status === 'DATA_UNAVAILABLE' || (!usablePrice && saved.status !== 'STALE');
  if (!unavailable && saved.status !== 'STALE' && candle <= scanned &&
      timestampIsRecent(scanned, maxAgeSeconds, now) && timestampIsRecent(candle, maxAgeSeconds, now)) {
    return Number.isFinite(saved.priceChangePercent24h) ? candidate : { ...candidate, priceChangePercent24h: null };
  }
  return {
    ...candidate,
    status: unavailable ? 'DATA_UNAVAILABLE' : 'STALE',
    side: 'WAIT',
    setup: null,
    price: null,
    priceChangePercent24h: null,
    rationale: 'WAIT: saved market data is stale or unavailable. Reloading this page does not fetch a new market scan.',
    warnings: [...new Set([...saved.warnings, 'A new market scan is required; cached prices and entry targets are withheld.'])],
  };
}

export function scannerSyncIsRecent(lastSuccess: string | Date, now = Date.now()) {
  const time = new Date(lastSuccess).getTime();
  return Number.isFinite(time) && time <= now && now - time <= 30 * 60_000;
}

const liveSignalStatuses = new Set(['ACTIVE', 'TP1_HIT', 'TP2_HIT']);

/** Persisted signal validity can end before the underlying scanner cache ages out. */
export function applyScannerSignalValidity(
  candidate: MarketScannerCandidate,
  signal: { generatedAt: string; expiresAt: string; status: string } | null | undefined,
  now: number,
): MarketScannerCandidate {
  if (candidate.status !== 'READY' || !signal) return candidate;
  const generatedAt = new Date(signal.generatedAt).getTime();
  const expiresAt = new Date(signal.expiresAt).getTime();
  if (liveSignalStatuses.has(signal.status) && generatedAt > 0 && generatedAt <= now && now < expiresAt) return candidate;
  return {
    ...candidate,
    status: 'WAIT',
    side: 'WAIT',
    setup: null,
    rationale: 'WAIT: the saved signal is outside its active window or its validity is unavailable.',
    warnings: [...candidate.warnings, 'The previous signal is no longer actionable.'],
  };
}
