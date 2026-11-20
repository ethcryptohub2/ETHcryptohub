import type { MarketScannerCandidate } from '../smartexit/apps/api/src/services/market-scanner';

// Reading a saved scan never refreshes its market data or makes it actionable.
export function savedScannerCandidate(
  saved: MarketScannerCandidate,
  scannedAt: string,
  maxAgeSeconds: number,
  now: number,
): MarketScannerCandidate {
  const scanned = new Date(scannedAt).getTime();
  const candle = Date.parse(saved.lastCandleCloseAt ?? '');
  const recent = (time: number) => Number.isFinite(time) && time <= now && now - time <= maxAgeSeconds * 1000;
  const candidate = { ...saved, scannedAt: Number.isFinite(scanned) ? new Date(scanned).toISOString() : undefined };
  if (recent(scanned) && recent(candle) && saved.status !== 'STALE' && saved.status !== 'DATA_UNAVAILABLE') return candidate;
  return {
    ...candidate,
    status: saved.status === 'DATA_UNAVAILABLE' ? 'DATA_UNAVAILABLE' : 'STALE',
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
