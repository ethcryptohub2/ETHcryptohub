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
