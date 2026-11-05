export type Side = 'LONG' | 'SHORT';

export type TradeStatus =
  | 'OPEN'
  | 'TP1_HIT_TRAILING'
  | 'TP2_HIT_TRAILING'
  | 'COMPLETED_TP3'
  | 'STOPPED_INITIAL_SL'
  | 'STOPPED_TRAILING_SL'
  | 'CANCELLED';

export interface Trade {
  id: string;
  symbol: string;
  quoteAsset: string;
  side: Side;
  status: TradeStatus;
  entryPrice: number;
  quantity: number;
  initialStop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  trailingPercent: number;
  trailingActive: boolean;
  trailingStop: number | null;
  highestPriceSinceTp1: number | null;
  lowestPriceSinceTp1: number | null;
  currentPrice: number;
  exitPrice: number | null;
  realizedPnl: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  notes: string | null;
}

export interface RiskSettings {
  paperEquity: number;
  maxOpenPositions: number;
  maxRiskPerTradePercent: number;
  maxDailyLossPercent: number;
  killSwitchEnabled: boolean;
  updatedAt: string;
}

export interface TradeEvent {
  id: string;
  tradeId: string;
  eventKey: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  createdAt: string;
}
