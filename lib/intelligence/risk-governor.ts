import type { MarketObservation, ResearchDecision, ResearchStrategy } from './contracts';

export interface PaperRiskPolicy {
  riskPerTradePct: number;
  maxPortfolioExposurePct: number;
  maxCorrelatedExposurePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxPositions: number;
  leverageCeiling: number;
  minLiquidationDistancePct: number;
  maxMarketAgeMs: number;
  maxConsecutiveLosses: number;
  lossCooldownMs: number;
  symbolExclusions: string[];
  allowedStrategies: ResearchStrategy[];
}
export interface PaperExposure {
  symbol: string;
  notional: number;
  riskAmount: number;
  correlationGroup: string;
}
export interface PaperRiskAccount {
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
  realizedDailyPnl: number;
  freeMargin: number;
  exchangeAvailable: boolean;
  killSwitch: boolean;
  consecutiveLosses: number;
  lastLossAt: number | null;
  positions: PaperExposure[];
  portfolioMarksVerified?: boolean;
}
export interface PaperIntent {
  idempotencyKey: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  leverage: number;
  /** Caller-supplied conservative estimate, not an exchange liquidation quote. */
  estimatedLiquidationPrice: number;
  correlationGroup: string;
}
export interface PaperRiskDecision {
  allowed: boolean;
  reasons: string[];
  riskAmount: number;
  notional: number;
  marginRequired: number;
  evaluatedAt: number;
}

export function defaultPaperRiskPolicy(): PaperRiskPolicy {
  return {
    riskPerTradePct: 1, maxPortfolioExposurePct: 100, maxCorrelatedExposurePct: 40,
    maxDailyLossPct: 3, maxDrawdownPct: 10, maxPositions: 3, leverageCeiling: 3,
    minLiquidationDistancePct: 15, maxMarketAgeMs: 5_000, maxConsecutiveLosses: 3,
    lossCooldownMs: 60 * 60_000, symbolExclusions: [], allowedStrategies: ['STANDARD'],
  };
}

const finite = (n: number) => Number.isFinite(n);
const positive = (n: number) => finite(n) && n > 0;
const validSymbol = (symbol: string) => typeof symbol === 'string' &&
  /^[\p{L}\p{N}_]{3,40}$/u.test(symbol) && symbol === symbol.toUpperCase();
export function validatePaperRiskPolicy(policy: PaperRiskPolicy): void {
  const fields = ['riskPerTradePct', 'maxPortfolioExposurePct', 'maxCorrelatedExposurePct',
    'maxDailyLossPct', 'maxDrawdownPct', 'maxPositions', 'leverageCeiling',
    'minLiquidationDistancePct', 'maxMarketAgeMs', 'maxConsecutiveLosses',
    'lossCooldownMs', 'symbolExclusions', 'allowedStrategies'];
  const positiveFields = [policy.riskPerTradePct, policy.maxPortfolioExposurePct,
    policy.maxCorrelatedExposurePct, policy.maxDailyLossPct, policy.maxDrawdownPct,
    policy.maxPositions, policy.leverageCeiling, policy.minLiquidationDistancePct,
    policy.maxMarketAgeMs, policy.maxConsecutiveLosses, policy.lossCooldownMs];
  if (Object.keys(policy).some(key => !fields.includes(key)) || !positiveFields.every(positive) || policy.riskPerTradePct > 10 ||
      policy.maxDailyLossPct > 100 || policy.maxDrawdownPct > 100 ||
      policy.minLiquidationDistancePct >= 100 || policy.leverageCeiling > 20 ||
      !Number.isInteger(policy.maxPositions) || !Number.isInteger(policy.maxConsecutiveLosses) ||
      !Array.isArray(policy.symbolExclusions) || policy.symbolExclusions.length > 5000 || !policy.symbolExclusions.every(validSymbol) ||
      !Array.isArray(policy.allowedStrategies) || policy.allowedStrategies.length === 0 || policy.allowedStrategies.length > 2 ||
      !policy.allowedStrategies.every(s => s === 'STANDARD' || s === 'HIGH_RISK')) {
    throw new Error('Invalid deterministic paper risk policy.');
  }
}

/** Deterministic authority: signal scores and narrative fields never override a rejection. */
export function evaluatePaperRisk(input: {
  policy: PaperRiskPolicy;
  account: PaperRiskAccount;
  intent: PaperIntent;
  market: MarketObservation;
  signal: ResearchDecision;
  now: number;
  duplicate?: boolean;
}): PaperRiskDecision {
  const { policy, account, intent, market, signal, now } = input;
  const reasons: string[] = [];
  const reject = (reason: string) => { reasons.push(reason); };
  try { validatePaperRiskPolicy(policy); } catch { reject('INVALID_POLICY'); }
  const positions = Array.isArray(account.positions) ? account.positions : [];
  const numericAccount = [account.equity, account.peakEquity, account.dayStartEquity];
  if (!numericAccount.every(positive) || !finite(account.freeMargin) || account.freeMargin < 0 || !finite(account.realizedDailyPnl) ||
      !Number.isInteger(account.consecutiveLosses) || account.consecutiveLosses < 0 ||
      (account.lastLossAt !== null && (!finite(account.lastLossAt) || account.lastLossAt > now)) ||
      !Array.isArray(account.positions) || account.positions.some(p => !positive(p.notional) || !positive(p.riskAmount))) {
    reject('INVALID_ACCOUNT_STATE');
  }
  const intentFields = ['idempotencyKey', 'symbol', 'side', 'quantity', 'entryPrice', 'stopPrice',
    'leverage', 'estimatedLiquidationPrice', 'correlationGroup'];
  const validIntent = !Object.keys(intent).some(key => !intentFields.includes(key)) && [intent.quantity, intent.entryPrice, intent.stopPrice, intent.leverage,
    intent.estimatedLiquidationPrice].every(positive) &&
    (intent.side === 'LONG' || intent.side === 'SHORT') &&
    validSymbol(intent.symbol) && /^[A-Za-z0-9:_-]{1,128}$/.test(intent.idempotencyKey) &&
    typeof intent.correlationGroup === 'string' && intent.correlationGroup.length > 0 && intent.correlationGroup.length <= 64;
  if (!validIntent || !positive(now)) reject('INVALID_INTENT');
  const notional = validIntent ? intent.quantity * intent.entryPrice : 0;
  const riskAmount = validIntent ? intent.quantity * Math.abs(intent.entryPrice - intent.stopPrice) : 0;
  const marginRequired = validIntent ? notional / intent.leverage : 0;
  if (![notional, riskAmount, marginRequired].every(positive)) reject('INVALID_POSITION_SIZE');
  if (input.duplicate) reject('DUPLICATE_INTENT');
  if (account.killSwitch) reject('KILL_SWITCH');
  if (!account.exchangeAvailable) reject('EXCHANGE_OUTAGE');
  if (account.portfolioMarksVerified === false) reject('PORTFOLIO_MARKS_UNAVAILABLE');
  const recent = (time: number) => finite(time) && time <= now && now - time <= policy.maxMarketAgeMs;
  if (!market.fresh || !market.sequenceValid || !recent(market.eventTime) || !recent(market.receivedAt) ||
      market.eventTime > market.receivedAt) reject('STALE_OR_UNVERIFIED_MARKET');
  if (![market.price, market.bid, market.ask, market.bidDepth, market.askDepth].every(positive) || market.ask < market.bid) reject('INVALID_MARKET');
  if (market.symbol !== intent.symbol || signal.symbol !== intent.symbol || market.source !== 'BINANCE_USDM') reject('SYMBOL_OR_SOURCE_MISMATCH');
  if (signal.classification !== 'READY_FOR_RESEARCH' || signal.side !== intent.side ||
      !finite(signal.observedAt) || signal.observedAt > now || !finite(signal.expiresAt) || signal.expiresAt <= now) reject('SIGNAL_NOT_ELIGIBLE');
  if (!policy.allowedStrategies?.includes(signal.strategy)) reject('STRATEGY_NOT_PERMITTED');
  if (policy.symbolExclusions?.includes(intent.symbol)) reject('SYMBOL_EXCLUDED');
  if ((intent.side === 'LONG' && intent.stopPrice >= intent.entryPrice) ||
      (intent.side === 'SHORT' && intent.stopPrice <= intent.entryPrice)) reject('INVALID_STOP_DIRECTION');
  if (intent.leverage > policy.leverageCeiling) reject('LEVERAGE_CEILING');
  if (riskAmount > account.equity * policy.riskPerTradePct / 100) reject('PER_TRADE_RISK');
  if (positions.length >= policy.maxPositions) reject('MAXIMUM_POSITIONS');
  const exposure = positions.reduce((sum, p) => sum + p.notional, 0);
  // No statistically verified correlation matrix is available yet. Treat all
  // crypto exposure as correlated; a caller-selected label cannot weaken risk.
  const correlated = exposure;
  if (exposure + notional > account.equity * policy.maxPortfolioExposurePct / 100) reject('PORTFOLIO_EXPOSURE');
  if (correlated + notional > account.equity * policy.maxCorrelatedExposurePct / 100) reject('CORRELATED_EXPOSURE');
  if (account.realizedDailyPnl <= -account.dayStartEquity * policy.maxDailyLossPct / 100) reject('DAILY_LOSS_LIMIT');
  if ((account.peakEquity - account.equity) / account.peakEquity * 100 >= policy.maxDrawdownPct) reject('MAXIMUM_DRAWDOWN');
  if (marginRequired > account.freeMargin) reject('INSUFFICIENT_MARGIN');
  const liquidationSideValid = intent.side === 'LONG'
    ? intent.estimatedLiquidationPrice < intent.stopPrice
    : intent.estimatedLiquidationPrice > intent.stopPrice;
  // Never trust an arbitrarily distant caller estimate. This conservative paper
  // ceiling is not an exchange-specific maintenance-margin liquidation model.
  const liquidationDistancePct = Math.min(
    Math.abs(intent.entryPrice - intent.estimatedLiquidationPrice) / intent.entryPrice * 100,
    75 / intent.leverage,
  );
  const stopDistancePct = Math.abs(intent.entryPrice - intent.stopPrice) / intent.entryPrice * 100;
  if (!liquidationSideValid || liquidationDistancePct < policy.minLiquidationDistancePct ||
      stopDistancePct >= liquidationDistancePct) reject('LIQUIDATION_DISTANCE');
  if (account.consecutiveLosses >= policy.maxConsecutiveLosses &&
      (account.lastLossAt === null || now - account.lastLossAt < policy.lossCooldownMs)) reject('LOSS_COOLDOWN');
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], riskAmount, notional, marginRequired, evaluatedAt: now };
}
