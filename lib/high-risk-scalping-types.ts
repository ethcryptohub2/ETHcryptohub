export const SCALPING_TIMEFRAMES = ['1m', '3m', '5m', '15m'] as const;
export type ScalpingTimeframe = typeof SCALPING_TIMEFRAMES[number];
export type ScalpingSide = 'LONG' | 'SHORT';

export interface HighRiskScalpingSettings {
  enabled: boolean;
  enabledTimeframes: ScalpingTimeframe[];
  minimumSetupScore: number;
  minimumQuoteVolume: number;
  minimumRelativeVolume: number;
  entryValidityMinutes: Record<ScalpingTimeframe, number>;
  signalValidityMinutes: Record<ScalpingTimeframe, number>;
}

export interface ScalpingSetup {
  signalKey: string;
  symbol: string;
  timeframe: ScalpingTimeframe;
  side: ScalpingSide;
  score: number;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stop: number;
  tp1: number;
  tp2: number;
  lastPrice: number;
  candleOpenAt: string;
  context: {
    rsi: number;
    relativeVolume: number;
    ema9: number;
    ema20: number;
    vwap: number;
    adx: number;
    supertrend: 'BULLISH' | 'BEARISH';
    btcDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    breakoutLevel: number;
    warning: 'HIGH RISK · informational only; no order is placed.';
  };
}

export interface StoredScalpingSignal extends ScalpingSetup {
  id: string;
  generatedAt: string;
  entryExpiresAt: string;
  expiresAt: string;
  lifecycleStatus: 'ACTIVE' | 'MISSED' | 'EXPIRED' | 'INVALIDATED' | 'ENTRY_INVALIDATED' | 'COMPLETED' |
    'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'STOP_LOSS_HIT' | 'AMBIGUOUS';
  userState: 'ENTERED' | 'CLOSED' | null;
}
