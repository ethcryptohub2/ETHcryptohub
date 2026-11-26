export type MarketDataProviderId = 'binance' | 'coinapi' | 'cryptodatadownload';
export type HistoricalProviderId = 'binance-vision';
export type AnyProviderId = MarketDataProviderId | HistoricalProviderId;

export type ProviderCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'DISABLED' | 'UNCONFIGURED';

export type ProviderTimeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h';

export interface NormalizedInstrument {
  symbol: string; // e.g. BTCUSDT
  baseAsset: string;
  quoteAsset: 'USDT';
  contractType: 'PERPETUAL';
  exchange: 'BINANCE';
  status: 'TRADING' | string;
  providerSymbol: string;
}

export interface NormalizedTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent24h: number | null;
  quoteVolume24h: number | null;
  timestamp: number;
  sourceProvider: MarketDataProviderId;
}

export interface NormalizedCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  closeTime: number;
  isClosed: boolean;
}

export interface ProviderCapabilities {
  liveCandles: boolean;
  liveTickers: boolean;
  instrumentDiscovery: boolean;
  historicalOnly: boolean;
  webSocket: boolean;
  supportedTimeframes: readonly ProviderTimeframe[];
}

export interface ProviderQuotaInfo {
  dailyLimit: number | null;
  dailyUsed: number;
  minuteWeightLimit: number | null;
  minuteWeightUsed: number;
  resetAt: number | null;
}

export interface ProviderHealthSnapshot {
  id: AnyProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  circuitState: ProviderCircuitState;
  cooldownUntil: number | null;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorSanitized: string | null;
  quota: ProviderQuotaInfo;
  capabilities: ProviderCapabilities;
}

export interface FailoverCandleResponse {
  candles: NormalizedCandle[];
  provider: AnyProviderId;
  historicalOnly: boolean;
  isFresh: boolean;
  fetchedAt: number;
}

export interface MarketDataSettingsView {
  autoFailoverEnabled: boolean;
  binanceEnabled: boolean;
  coinapiEnabled: boolean;
  coinapiConfigured: boolean;
  coinapiKeyMasked: string | null;
  alternativeEnabled: boolean;
  historicalCacheEnabled: boolean;
  freeOnlyPolicy: boolean;
  fullScanIntervalSeconds: number;
  updatedAt: string | null;
}
