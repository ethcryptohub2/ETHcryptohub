import { binanceRateLimiter } from '../binance-rate-limit';
import { ProviderHealthTracker } from './provider-health';
import type { ProviderHealthSnapshot } from './provider-types';

export const binanceTracker = new ProviderHealthTracker({
  id: 'binance',
  label: 'Binance Official USD-M Futures',
  dailyLimit: null,
  enabled: true,
  configured: true,
  capabilities: {
    liveCandles: true,
    liveTickers: true,
    instrumentDiscovery: true,
    historicalOnly: false,
    webSocket: true,
    supportedTimeframes: ['1m', '3m', '5m', '15m', '1h', '4h'],
  },
});

export const coinapiTracker = new ProviderHealthTracker({
  id: 'coinapi',
  label: 'CoinAPI (BINANCEFTS)',
  dailyLimit: 100, // Verified Free Tier: 100 requests/day
  enabled: true,
  configured: false,
  capabilities: {
    liveCandles: true,
    liveTickers: false,
    instrumentDiscovery: true,
    historicalOnly: false,
    webSocket: true,
    supportedTimeframes: ['1m', '3m', '5m', '15m', '1h', '4h'],
  },
});

export const cryptoDataDownloadTracker = new ProviderHealthTracker({
  id: 'cryptodatadownload',
  label: 'CryptoDataDownload (Historical Fallback)',
  dailyLimit: null,
  enabled: false, // Disabled as live provider: free endpoints are historical-only
  configured: true,
  capabilities: {
    liveCandles: false,
    liveTickers: false,
    instrumentDiscovery: false,
    historicalOnly: true,
    webSocket: false,
    supportedTimeframes: ['1h', '4h'],
  },
});

export const binanceVisionTracker = new ProviderHealthTracker({
  id: 'binance-vision',
  label: 'Binance Vision Historical Archive',
  dailyLimit: null,
  enabled: true,
  configured: true,
  capabilities: {
    liveCandles: false,
    liveTickers: false,
    instrumentDiscovery: false,
    historicalOnly: true,
    webSocket: false,
    supportedTimeframes: ['1m', '3m', '5m', '15m', '1h', '4h'],
  },
});

export function getAllProviderHealthSnapshots(now = Date.now()): ProviderHealthSnapshot[] {
  const cb = binanceRateLimiter.getStatus(now);
  if (cb.state === 'OPEN') {
    binanceTracker.syncExternalCooldown('OPEN', cb.cooldownUntil, cb.reason);
  } else if (cb.state === 'HALF_OPEN') {
    binanceTracker.syncExternalCooldown('HALF_OPEN', cb.cooldownUntil, cb.reason);
  }
  return [
    binanceTracker.snapshot(now, cb.usedWeight1m, cb.weightLimit1m),
    coinapiTracker.snapshot(now),
    cryptoDataDownloadTracker.snapshot(now),
    binanceVisionTracker.snapshot(now),
  ];
}

export function resetAllProviderTrackers(): void {
  binanceTracker.reset();
  coinapiTracker.reset();
  cryptoDataDownloadTracker.reset();
  binanceVisionTracker.reset();
}
