export const EXCHANGE_IDS = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export const EXCHANGE_ENVIRONMENTS = {
  BINANCE: ['DEMO', 'LIVE'],
  BYBIT: ['DEMO', 'LIVE'],
  OKX: ['DEMO', 'LIVE'],
  BITGET: ['DEMO', 'LIVE'],
  GATE: ['TESTNET', 'LIVE'],
} as const satisfies Record<ExchangeId, readonly string[]>;

export type ExchangeEnvironment = 'DEMO' | 'TESTNET' | 'LIVE';
export type ExchangeSide = 'LONG' | 'SHORT';
export type ExchangeOrderSide = 'BUY' | 'SELL';

export type ExchangeCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export type ExchangeBalance = {
  asset: string;
  walletBalance: string;
  availableBalance: string;
  equity?: string;
  unrealizedPnl: string;
};

export type ExchangeInstrument = {
  exchangeSymbol: string;
  smartExitSymbol: string;
  contractType: 'PERPETUAL' | 'OTHER';
  quoteAsset: string;
  status: string;
  tickSize: string;
  quantityStep: string;
  minimumQuantity: string;
  maximumQuantity: string | null;
  minimumNotional: string | null;
  contractSize: string;
  maximumLeverage: number | null;
};

export type ExchangeTicker = {
  symbol: string;
  lastPrice: string;
  markPrice: string | null;
};

export type ExchangePosition = {
  symbol: string;
  side: ExchangeSide;
  quantity: string;
  entryPrice: string;
  markPrice: string | null;
  unrealizedPnl: string;
  leverage: number | null;
};

export type ExchangeOrder = {
  symbol: string;
  exchangeOrderId: string;
  clientOrderId: string | null;
  side: ExchangeOrderSide;
  type: string;
  status: string;
  quantity: string;
  filledQuantity: string;
  price: string | null;
};

export type ExchangeApiResult<T> = {
  exchange: ExchangeId;
  environment: ExchangeEnvironment;
  data: T;
};

export type ExchangeCapabilities = {
  connectionTest: boolean;
  balance: boolean;
  instruments: boolean;
  ticker: boolean;
  positions: boolean;
  orders: boolean;
  leverage: boolean;
  marketOrders: boolean;
  limitOrders: boolean;
  cancelOrders: boolean;
  positionTakeProfitStopLoss: boolean;
  safePositionClose: boolean;
};

export type ExchangeAdapter = {
  exchange: ExchangeId;
  environment: ExchangeEnvironment;
  testConnection(): Promise<void>;
  getAccountBalance(): Promise<ExchangeBalance[]>;
  getMarketInstruments(): Promise<ExchangeInstrument[]>;
  getTicker(symbol: string): Promise<ExchangeTicker>;
  getPositions(): Promise<ExchangePosition[]>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrderHistory(symbol: string, limit?: number): Promise<ExchangeOrder[]>;
  getExecutionHistory(symbol: string, limit?: number): Promise<unknown[]>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(input: {
    symbol: string;
    side: ExchangeOrderSide;
    quantity: string;
    clientOrderId: string;
    reduceOnly?: boolean;
  }): Promise<ExchangeOrder>;
  placeLimitOrder(input: {
    symbol: string;
    side: ExchangeOrderSide;
    quantity: string;
    price: string;
    clientOrderId: string;
    reduceOnly?: boolean;
  }): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  setPositionStopLoss(symbol: string, triggerPrice: string): Promise<void>;
  setPositionTakeProfit(symbol: string, triggerPrice: string): Promise<void>;
  closePosition(symbol: string): Promise<ExchangeOrder>;
  reconcileOrder(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null>;
};

export function isExchangeId(value: unknown): value is ExchangeId {
  return typeof value === 'string' && (EXCHANGE_IDS as readonly string[]).includes(value);
}

export function isExchangeEnvironment(
  exchange: ExchangeId,
  environment: unknown,
): environment is ExchangeEnvironment {
  return typeof environment === 'string' &&
    (EXCHANGE_ENVIRONMENTS[exchange] as readonly string[]).includes(environment);
}
