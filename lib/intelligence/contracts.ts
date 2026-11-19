/** Shared research contracts. No credential, exchange-order or tenant-secret fields. */
export interface MarketObservation {
  symbol: string;
  source: 'BINANCE_USDM';
  eventTime: number;
  receivedAt: number;
  /** Duration of the non-overlapping trade-notional sample, never assumed cadence. */
  volumeIntervalMs?: number;
  price: number;
  bid: number;
  ask: number;
  quoteVolume: number;
  buyQuoteVolume: number;
  sellQuoteVolume: number;
  bidDepth: number;
  askDepth: number;
  openInterest?: number;
  fundingRate?: number;
  fresh: boolean;
  sequenceValid: boolean;
  /** Changes when continuity is lost. Consumers must discard prior per-symbol history. */
  feedEpoch?: number;
  /** Exchange timestamps of every required input; newest eventTime alone is insufficient. */
  requiredInputTimes?: { ticker: number; trade: number; depth: number };
}

export type ResearchClassification = 'WATCH' | 'READY_FOR_RESEARCH' | 'REJECTED';
export type ResearchStrategy = 'STANDARD' | 'HIGH_RISK';
export interface ResearchDecision {
  id: string;
  symbol: string;
  strategy: ResearchStrategy;
  classification: ResearchClassification;
  side: 'LONG' | 'SHORT' | 'WAIT';
  score: number;
  observedAt: number;
  expiresAt: number;
  reasons: string[];
  evidence: Record<string, number | string | boolean | null>;
}

export const CUSTOMER_PAPER_MODES = ['OBSERVE', 'CONFIRM', 'PAPER_AUTOPILOT'] as const;
export type CustomerPaperMode = typeof CUSTOMER_PAPER_MODES[number];
