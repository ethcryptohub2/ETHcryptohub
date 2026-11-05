export interface Trade {
  id: string;
  symbol: string;
  quoteAsset: string;
  side: 'LONG' | 'SHORT';
  status: string;
  entryPrice: number;
  quantity: number;
  initialStop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  trailingPercent: number;
  trailingActive: boolean;
  trailingStop: number | null;
  currentPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
  createdAt: string;
  closedAt: string | null;
  notes: string | null;
}

export interface TradeEvent {
  id: string;
  tradeId: string;
  eventKey: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  createdAt: string;
}

export interface RiskSettings {
  paperEquity: number;
  maxOpenPositions: number;
  maxRiskPerTradePercent: number;
  maxDailyLossPercent: number;
  killSwitchEnabled: boolean;
  updatedAt: string;
}

export interface RiskData {
  settings: RiskSettings;
  openPositions: number;
  daily: { dayUtc: string; startingEquity: number; realizedPnl: number; lossLimit: number; blocked: boolean };
}

export interface Health {
  status: string;
  mode: string;
  database: string;
  liveOrdersEnabled: boolean;
}

export interface NearStatus {
  status: string;
  message: string;
  swapsEnabled: boolean;
}

export interface PaperUser {
  id: string;
  nearAccountId: string;
  startingBalance: number;
  realizedPnl: number;
}

export interface PaperPortfolio {
  startingBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  cashBalance: number;
  totalEquity: number;
  assetBalances: Array<{
    asset: string;
    startingBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    cashBalance: number;
  }>;
}

export interface NearChallenge {
  id: string;
  nonce: string;
  message: string;
  recipient: string;
}

export type NearNetwork = 'mainnet' | 'testnet';

export interface FuturesMarketSymbol {
  symbol: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number | null;
  priceChangePercent24h: number | null;
  quoteVolume24h: number;
  tradeCount24h: number;
}

export interface FuturesMarkets {
  exchange: 'BINANCE';
  market: 'USDⓈ-M FUTURES';
  source: string;
  updatedAt: string;
  symbols: FuturesMarketSymbol[];
}

export interface ScannerContribution {
  factor: string;
  weight: number;
  value: number;
  contribution: number;
}

export type MarketRank = 'TOP_VOLUME' | 'TOP_GAINER' | 'TOP_LOSER';

export interface ScannerCandidate {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marketRank: MarketRank[];
  price: number | null;
  priceChangePercent24h: number | null;
  quoteVolume24h: number;
  timeframe: '5m' | '15m' | '1h' | '4h';
  lastCandleCloseAt: string | null;
  supertrend: {
    direction: 'BULLISH' | 'BEARISH' | 'UNAVAILABLE';
    atr: number | null;
    period: number;
    multiplier: number;
  };
  ema: {
    ema9: number | null;
    ema20: number | null;
    ema50: number | null;
    ema100: number | null;
    ema200: number | null;
    direction: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNAVAILABLE';
  };
  indicators: {
    rsi14: number | null;
    macdLine: number | null;
    macdSignal: number | null;
    macdHistogram: number | null;
    rollingVwap20: number | null;
    bollingerBands20: { lower: number; middle: number; upper: number } | null;
    adx14: number | null;
  };
  supportResistance: {
    support: number | null;
    resistance: number | null;
    source: 'COMPLETED_CANDLE_SWINGS';
  };
  relativeVolume: number | null;
  newsSentiment: { status: 'UNAVAILABLE'; source: null; updatedAt: null };
  socialSentiment: { status: 'UNAVAILABLE'; source: null; updatedAt: null };
  score: { value: number | null; coverage: number; contributions: ScannerContribution[] };
  side: 'LONG' | 'SHORT' | 'WAIT';
  status: 'READY' | 'WAIT' | 'STALE' | 'DATA_UNAVAILABLE';
  setup: {
    entryPrice: number;
    quantity: number;
    initialStop: number;
    trailingPercent: number;
    tp1: number;
    tp2: number;
    tp3: number;
    estimatedRisk: number;
    riskReward: [1, 2, 3];
  } | null;
  rationale: string;
  warnings: string[];
}

export interface MarketScannerResponse {
  exchange: 'BINANCE';
  market: 'USDⓈ-M FUTURES';
  source: string;
  updatedAt: string;
  timeframe: ScannerCandidate['timeframe'];
  configuration: {
    quoteAsset: string;
    timeframe: ScannerCandidate['timeframe'];
    minimumVolume: number;
    limit: number;
    atrPeriod: number;
    multiplier: number;
    maxAgeSeconds: number;
    minimumScore: number;
  };
  status: 'LIVE' | 'DEGRADED';
  candidates: ScannerCandidate[];
}

interface ApiResponse<T> {
  data?: T;
  error?: { code: string; message: string };
  meta?: { duplicate?: boolean; estimatedRisk?: number; riskBudget?: number };
}

async function readApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      response.status >= 500
        ? 'The SmartExit server is temporarily unavailable. Check that the PHP bridge and SmartExit API are running.'
        : `The SmartExit server returned an unexpected response (${response.status}).`,
    );
  }

  try {
    return (await response.json()) as ApiResponse<T>;
  } catch {
    throw new Error(`The SmartExit server returned invalid JSON (${response.status}).`);
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; meta?: ApiResponse<T>['meta'] }> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !csrfToken) {
    throw new Error('Your secure session token is missing. Reload the page and try again.');
  }
  let response: Response;
  try {
    response = await fetch(`/smartexit-api.php?path=${encodeURIComponent(`/api${path}`)}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)
          ? { 'X-CSRF-Token': csrfToken }
          : {}),
        ...init?.headers,
      },
    });
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') throw reason;
    throw new Error(
      'Could not reach the SmartExit API. Check the PHP bridge URL and the backend connection, then retry.',
    );
  }
  const body = await readApiResponse<T>(response);
  if (!response.ok || body.data === undefined) {
    throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  }
  return { data: body.data, ...(body.meta ? { meta: body.meta } : {}) };
}

export const money = (value: number | null): string =>
  value === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
        value,
      );

export const price = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
