import type { MarketObservation, ResearchDecision, ResearchStrategy } from './contracts';

export interface ClosedBar {
  openTime: number; closeTime: number; availableAt: number;
  open: number; high: number; low: number; close: number; volume: number;
}
export interface OnChainContext {
  provider: string; observedAt: number; attribution: 'UNVERIFIED' | 'PROVIDER_ATTRIBUTED' | 'VERIFIED';
  confidence: number; netflow: number | null; evidenceUrl?: string;
}
export interface OnChainResearchProvider { context(symbol: string, asOf: number): Promise<OnChainContext | null> }
export interface ResearchBookContext { observedAt: number; bids: readonly (readonly [number, number])[]; asks: readonly (readonly [number, number])[] }
export function orderBookGapBps(book: ResearchBookContext | undefined, now: number, maxAgeMs = 5_000): number | null {
  if (!book || !Number.isFinite(book.observedAt) || book.observedAt > now || now - book.observedAt > maxAgeMs ||
    book.bids.length < 2 || book.asks.length < 2 || book.bids.length > 100 || book.asks.length > 100) return null;
  for (const [levels, direction] of [[book.bids, -1], [book.asks, 1]] as const) {
    if (levels.some(([price, quantity], index) => !Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0 ||
      (index > 0 && direction * (price - levels[index - 1]![0]) <= 0))) return null;
  }
  if (book.bids[0]![0] >= book.asks[0]![0]) return null;
  const mid = (book.bids[0]![0] + book.asks[0]![0]) / 2;
  return Math.max(...[book.bids, book.asks].flatMap((levels) => levels.slice(1, 10).map(([price], index) =>
    Math.abs(price - levels[index]![0]) / mid * 10_000)));
}
export function analyzeOnChainContext(context: OnChainContext | null, asOf: number, maxAgeMs = 60_000) {
  const valid = context && typeof context.provider === 'string' && context.provider.trim().length > 0 && context.provider.length <= 100 &&
    Number.isFinite(context.observedAt) && context.observedAt <= asOf &&
    asOf - context.observedAt <= maxAgeMs && Number.isFinite(context.confidence) && context.confidence >= 0 && context.confidence <= 1 &&
    ['UNVERIFIED', 'PROVIDER_ATTRIBUTED', 'VERIFIED'].includes(context.attribution) &&
    (context.netflow === null || Number.isFinite(context.netflow));
  return valid ? { available: true, provider: context.provider, attribution: context.attribution,
    confidence: context.confidence, netflow: context.netflow, observedAt: context.observedAt,
    exchangeTraderIdentityLinked: false as const } : { available: false, reason: 'UNAVAILABLE_OR_STALE_ONCHAIN', exchangeTraderIdentityLinked: false as const };
}
/** Optional injected transport: credentials/network provisioning stay outside research. */
export function createOnChainResearchProvider(provider: string, read: (symbol: string, asOf: number) => Promise<unknown>): OnChainResearchProvider {
  if (!provider.trim() || provider.length > 100) throw new Error('Invalid on-chain provider.');
  return { async context(symbol, asOf) {
    if (!/^[\p{L}\p{N}_]{2,40}$/u.test(symbol) || !Number.isFinite(asOf)) return null;
    try {
      const raw = await read(symbol, asOf);
      if (!raw || typeof raw !== 'object') return null;
      const candidate = { ...raw, provider } as OnChainContext;
      return analyzeOnChainContext(candidate, asOf).available ? candidate : null;
    } catch { return null; }
  } };
}

export interface ResearchJournal { append(decision: ResearchDecision): void }
export class MemoryResearchJournal implements ResearchJournal {
  private entries: ResearchDecision[] = [];
  private readonly capacity: number;
  constructor(capacity = 2_000) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000) throw new Error('Invalid journal capacity.');
    this.capacity = capacity;
  }
  append(decision: ResearchDecision) {
    this.entries.push(structuredClone(decision));
    if (this.entries.length > this.capacity) this.entries.shift();
  }
  read() { return structuredClone(this.entries); }
  serialize() { return JSON.stringify({ version: 1, entries: this.entries }); }
  static restore(serialized: string) {
    const state = JSON.parse(serialized) as { version?: number; entries?: ResearchDecision[] };
    if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 100_000) throw new Error('Invalid research journal.');
    const journal = new MemoryResearchJournal(Math.max(2_000, state.entries.length));
    for (const entry of state.entries) {
      if (!entry || !Array.isArray(entry.reasons) || !entry.evidence || !['STANDARD', 'HIGH_RISK'].includes(entry.strategy) ||
          !['WATCH', 'READY_FOR_RESEARCH', 'REJECTED'].includes(entry.classification)) throw new Error('Invalid research entry.');
      journal.append(entry);
    }
    return journal;
  }
}

export const RESEARCH_POLICIES = Object.freeze({
  STANDARD: Object.freeze({ bars: 20, fast: 5, slow: 13, spreadBps: 10, bookGapBps: 50, volumePerSecond: 10_000, relativeVolume: 2, score: 70, expiryMs: 300_000, cooldownMs: 300_000, atrMultiplier: 2 }),
  HIGH_RISK: Object.freeze({ bars: 10, fast: 3, slow: 8, spreadBps: 20, bookGapBps: 100, volumePerSecond: 5_000, relativeVolume: 1.5, score: 60, expiryMs: 60_000, cooldownMs: 60_000, atrMultiplier: 1.2 }),
});

const finite = (value: number) => Number.isFinite(value);
const observationFields = new Set([
  'symbol', 'source', 'eventTime', 'receivedAt', 'price', 'bid', 'ask', 'quoteVolume',
  'buyQuoteVolume', 'sellQuoteVolume', 'bidDepth', 'askDepth', 'openInterest', 'fundingRate',
  'fresh', 'sequenceValid', 'feedEpoch', 'volumeIntervalMs',
]);
function validObservation(value: MarketObservation) {
  return Object.keys(value).every((key) => observationFields.has(key)) &&
    value.source === 'BINANCE_USDM' && /^[\p{L}\p{N}_]{2,40}$/u.test(value.symbol) && value.symbol === value.symbol.toUpperCase() &&
    [value.eventTime, value.receivedAt, value.price, value.bid, value.ask, value.quoteVolume,
      value.buyQuoteVolume, value.sellQuoteVolume, value.bidDepth, value.askDepth].every(finite) &&
    value.price > 0 && value.bid > 0 && value.ask >= value.bid && value.quoteVolume >= 0 &&
    value.buyQuoteVolume >= 0 && value.sellQuoteVolume >= 0 && value.bidDepth >= 0 && value.askDepth >= 0 &&
    value.buyQuoteVolume + value.sellQuoteVolume <= value.quoteVolume * 1.000001 &&
    (value.openInterest === undefined || (finite(value.openInterest) && value.openInterest >= 0)) &&
    (value.fundingRate === undefined || finite(value.fundingRate)) &&
    (value.volumeIntervalMs === undefined || (finite(value.volumeIntervalMs) && value.volumeIntervalMs > 0 && value.volumeIntervalMs <= 60_000)) &&
    (value.feedEpoch === undefined || (Number.isSafeInteger(value.feedEpoch) && value.feedEpoch >= 0));
}
function ema(values: number[], period: number) {
  if (values.length < period) return null;
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const alpha = 2 / (period + 1);
  for (const value of values.slice(period)) result = value * alpha + result * (1 - alpha);
  return result;
}
function contextFromBars(bars: readonly ClosedBar[], now: number) {
  const closed = bars.filter((bar) => bar.availableAt <= now && bar.closeTime <= now)
    .sort((a, b) => a.closeTime - b.closeTime);
  if (closed.some((bar, index) => ![bar.openTime, bar.closeTime, bar.availableAt, bar.open, bar.high, bar.low, bar.close, bar.volume].every(finite) ||
    bar.openTime >= bar.closeTime || bar.availableAt < bar.closeTime || bar.low <= 0 || bar.high < Math.max(bar.open, bar.close) ||
    bar.low > Math.min(bar.open, bar.close) || bar.volume < 0 || (index > 0 && closed[index - 1]!.closeTime >= bar.closeTime))) return [];
  return closed;
}
function volatilityContext(bars: ClosedBar[]) {
  const ranges = bars.map((bar, index) => Math.max(bar.high - bar.low,
    index ? Math.abs(bar.high - bars[index - 1]!.close) : 0, index ? Math.abs(bar.low - bars[index - 1]!.close) : 0));
  const period = 7;
  if (ranges.length < period) return { atr: null, supertrend: 'UNAVAILABLE' };
  let atr = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let upper = (bars[period - 1]!.high + bars[period - 1]!.low) / 2 + 3 * atr;
  let lower = (bars[period - 1]!.high + bars[period - 1]!.low) / 2 - 3 * atr;
  let bullish = bars[period - 1]!.close >= (bars[period - 1]!.high + bars[period - 1]!.low) / 2;
  for (let index = period; index < bars.length; index++) {
    atr = (atr * (period - 1) + ranges[index]!) / period;
    const bar = bars[index]!; const previous = bars[index - 1]!;
    const basicUpper = (bar.high + bar.low) / 2 + 3 * atr;
    const basicLower = (bar.high + bar.low) / 2 - 3 * atr;
    const nextUpper = basicUpper < upper || previous.close > upper ? basicUpper : upper;
    const nextLower = basicLower > lower || previous.close < lower ? basicLower : lower;
    bullish = bullish ? bar.close >= nextLower : bar.close > nextUpper;
    upper = nextUpper; lower = nextLower;
  }
  return { atr, supertrend: bullish ? 'BULLISH' : 'BEARISH' };
}

interface EngineState {
  version: 1; serial: number; history: Record<string, MarketObservation[]>; cooldowns: Record<string, number>;
  epochs: Record<string, number>; contextSince: Record<string, number>;
}
export class ResearchEngine {
  private history = new Map<string, MarketObservation[]>();
  private cooldowns = new Map<string, number>();
  private epochs = new Map<string, number>();
  private contextSince = new Map<string, number>();
  private serial = 0;
  private readonly journal: ResearchJournal;
  private readonly maxAgeMs: number;
  constructor(journal: ResearchJournal = new MemoryResearchJournal(), maxAgeMs = 5_000) {
    if (!finite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60_000) throw new Error('Invalid freshness bound.');
    this.journal = journal; this.maxAgeMs = maxAgeMs;
  }
  ingest(observation: MarketObservation, now: number, context: { bars?: readonly ClosedBar[]; onChain?: OnChainContext | null; orderBook?: ResearchBookContext } = {}): ResearchDecision[] {
    const invalidClock = !finite(now) || now < 0;
    if (invalidClock) now = 0;
    const shapeValid = validObservation(observation);
    const invalid = invalidClock || !shapeValid || !observation.fresh || !observation.sequenceValid ||
      observation.eventTime > now || observation.receivedAt > now || observation.receivedAt < observation.eventTime ||
      now - observation.eventTime > this.maxAgeMs || now - observation.receivedAt > this.maxAgeMs;
    const epoch = observation.feedEpoch ?? 0;
    const oldEpoch = this.epochs.get(observation.symbol);
    if (!invalid && oldEpoch !== undefined && oldEpoch !== epoch) {
      this.history.delete(observation.symbol);
      this.cooldowns.delete(`STANDARD:${observation.symbol}`); this.cooldowns.delete(`HIGH_RISK:${observation.symbol}`);
      this.contextSince.set(observation.symbol, now);
    }
    if (!invalid) this.epochs.set(observation.symbol, epoch);
    if (this.epochs.size > 2_000) {
      const oldest = this.epochs.keys().next().value!;
      this.epochs.delete(oldest); this.history.delete(oldest); this.contextSince.delete(oldest);
      this.cooldowns.delete(`STANDARD:${oldest}`); this.cooldowns.delete(`HIGH_RISK:${oldest}`);
    }
    const originalHistory = this.history.get(observation.symbol) ?? [];
    const prior = originalHistory.filter((value) => now - value.eventTime <= 60_000);
    const duplicate = originalHistory.length > 0 && observation.eventTime <= originalHistory.at(-1)!.eventTime;
    const volumeInterval = observation.volumeIntervalMs ?? (originalHistory.length ? observation.eventTime - originalHistory.at(-1)!.eventTime : null);
    const staleVolumeWindow = volumeInterval !== null && volumeInterval > this.maxAgeMs;
    const bars = contextFromBars(context.bars ?? [], now).filter((bar) => bar.closeTime >= (this.contextSince.get(observation.symbol) ?? 0));
    const decisions = (['STANDARD', 'HIGH_RISK'] as const).map((strategy) => this.decide(observation, prior, bars, now, strategy,
      invalid ? 'INVALID_OR_STALE_REQUIRED_DATA' : duplicate ? 'DUPLICATE_OR_OUT_OF_ORDER_EVENT' : null, context.onChain ?? null,
      orderBookGapBps(context.orderBook, now, this.maxAgeMs)));
    // A rejected transport event never poisons baselines or CVD.
    if (!invalid && !duplicate && !staleVolumeWindow) {
      prior.push(structuredClone(observation));
      this.history.set(observation.symbol, prior.slice(-256));
      if (this.history.size > 2_000) {
        const oldest = this.history.keys().next().value!;
        this.history.delete(oldest); this.epochs.delete(oldest); this.contextSince.delete(oldest);
        this.cooldowns.delete(`STANDARD:${oldest}`); this.cooldowns.delete(`HIGH_RISK:${oldest}`);
      }
    }
    for (const decision of decisions) this.journal.append(decision);
    return decisions;
  }
  private decide(observation: MarketObservation, history: MarketObservation[], bars: ClosedBar[], now: number,
    strategy: ResearchStrategy, invalid: string | null, onChainContext: OnChainContext | null, bookGapBps: number | null): ResearchDecision {
    const policy = RESEARCH_POLICIES[strategy];
    const baseline = history.slice(-20);
    const rateAt = (value: MarketObservation, previous: MarketObservation | undefined) => {
      const duration = value.volumeIntervalMs ?? (previous ? value.eventTime - previous.eventTime : NaN);
      return finite(duration) && duration > 0 ? value.quoteVolume * 1000 / duration : null;
    };
    const historicalRates = history.map((value, index) => rateAt(value, history[index - 1])).slice(-20).filter((value): value is number => value !== null);
    const rate = rateAt(observation, history.at(-1));
    const mean = historicalRates.length ? historicalRates.reduce((sum, value) => sum + value, 0) / historicalRates.length : 0;
    const relativeVolume = mean > 0 && rate !== null ? rate / mean : 0;
    const previousRate = historicalRates.at(-1) ?? 0;
    const acceleration = previousRate > 0 && rate !== null ? (rate - previousRate) / previousRate : 0;
    const flowTotal = observation.buyQuoteVolume + observation.sellQuoteVolume;
    const aggression = flowTotal > 0 ? (observation.buyQuoteVolume - observation.sellQuoteVolume) / flowTotal : 0;
    const depth = observation.bidDepth + observation.askDepth;
    const imbalance = depth > 0 ? (observation.bidDepth - observation.askDepth) / depth : 0;
    const spreadBps = observation.price > 0 ? (observation.ask - observation.bid) / observation.price * 10_000 : Infinity;
    const cvd = [...baseline, observation].reduce((sum, value) => sum + value.buyQuoteVolume - value.sellQuoteVolume, 0);
    const closes = bars.map((bar) => bar.close);
    const fast = ema(closes, policy.fast); const slow = ema(closes, policy.slow);
    const volatility = volatilityContext(bars);
    const old = history.at(-1);
    const oiChange = old?.openInterest && observation.openInterest !== undefined ? (observation.openInterest - old.openInterest) / old.openInterest : null;
    const recentBars = bars.slice(-10);
    const breakout = recentBars.length > 0 && observation.price > Math.max(...recentBars.map((bar) => bar.high));
    const breakdown = recentBars.length > 0 && observation.price < Math.min(...recentBars.map((bar) => bar.low));
    const side = aggression >= 0 ? 'LONG' : 'SHORT';
    const trend = fast !== null && slow !== null ? fast > slow ? 'BULLISH' : fast < slow ? 'BEARISH' : 'RANGING' : 'UNKNOWN';
    const agrees = side === 'LONG' ? trend === 'BULLISH' && volatility.supertrend === 'BULLISH' : trend === 'BEARISH' && volatility.supertrend === 'BEARISH';
    const priceDelta = old && old.price > 0 ? Math.abs(observation.price - old.price) : 0;
    const expansion = volatility.atr && volatility.atr > 0 ? priceDelta / volatility.atr : null;
    const stopDistance = volatility.atr ? volatility.atr * policy.atrMultiplier : null;
    const riskReward = stopDistance && stopDistance > 0 ? 2 : null;
    const score = Math.min(100, Math.max(0, Math.round((relativeVolume >= policy.relativeVolume ? 25 : relativeVolume >= 1 ? 10 : 0) +
      (Math.abs(aggression) >= 0.3 ? 20 : 0) + (Math.abs(imbalance) >= 0.2 && Math.sign(imbalance) === Math.sign(aggression) ? 10 : 0) +
      (agrees ? 20 : 0) + ((side === 'LONG' ? breakout : breakdown) ? 15 : 0) + (acceleration > 0.5 ? 5 : 0) +
      (oiChange !== null && oiChange > 0 ? 5 : 0))));
    const onChain = analyzeOnChainContext(onChainContext, now);
    const evidence: ResearchDecision['evidence'] = {
      source: observation.source, volumeSemantics: 'NON_OVERLAPPING_INTERVAL_NOTIONAL', relativeVolume, volumeAcceleration: acceleration,
      aggressiveFlow: aggression, cumulativeVolumeDelta: cvd, orderBookImbalance: imbalance,
      thinDepthProxy: rate === null ? null : depth === 0 || Math.min(observation.bidDepth, observation.askDepth) < rate * 0.01,
      depthFlowReferenceSeconds: 1, minimumVolumeNotionalPerSecond: policy.volumePerSecond,
      liquidityGapBps: bookGapBps,
      spreadBps: finite(spreadBps) ? spreadBps : null, openInterestChange: oiChange, fundingRate: observation.fundingRate ?? null,
      emaFast: fast, emaSlow: slow, marketRegime: trend, supertrend: volatility.supertrend, atr: volatility.atr,
      breakout, breakdown, volatilityExpansion: expansion, entry: observation.price,
      stop: stopDistance ? observation.price + (side === 'LONG' ? -stopDistance : stopDistance) : null,
      target: stopDistance ? observation.price + (side === 'LONG' ? 2 * stopDistance : -2 * stopDistance) : null,
      riskReward, exchangeFlowAttribution: 'UNIDENTIFIED_EXCHANGE_ORDER_FLOW_NOT_VERIFIED_WHALE',
      warmupSamples: baseline.length, closedBars: bars.length,
      volumeNotionalPerSecond: rate, volumeBaselineRateSamples: historicalRates.length,
      onChainAvailable: onChain.available, onChainAttribution: onChain.available ? onChain.attribution ?? null : null,
      onChainConfidence: onChain.available ? onChain.confidence ?? null : null,
      onChainNetflow: onChain.available ? onChain.netflow ?? null : null,
    };
    for (const key of Object.keys(evidence)) if (typeof evidence[key] === 'number' && !finite(evidence[key] as number)) evidence[key] = null;
    const duration = observation.volumeIntervalMs ?? (old ? observation.eventTime - old.eventTime : null);
    const rejection = invalid ?? (duration !== null && duration > this.maxAgeMs ? 'VOLUME_WINDOW_TOO_OLD' :
      spreadBps > policy.spreadBps ? 'SPREAD_LIMIT' : depth <= 0 ? 'INSUFFICIENT_DEPTH' :
      bookGapBps !== null && bookGapBps > policy.bookGapBps ? 'ORDER_BOOK_GAP' :
      rate !== null && Math.min(observation.bidDepth, observation.askDepth) < rate * 0.01 ? 'LIQUIDITY_GAP' :
      rate !== null && rate < policy.volumePerSecond ? 'INSUFFICIENT_LIQUIDITY' :
      stopDistance !== null && (stopDistance <= 0 || stopDistance >= observation.price) ? 'INVALID_RISK_REWARD' : null);
    const reasons = rejection ? [rejection] : [];
    let classification: ResearchDecision['classification'] = rejection ? 'REJECTED' : 'WATCH';
    if (!rejection) {
      if (baseline.length < 4 || bars.length < policy.bars || bars.at(-1)!.closeTime < now - 300_000) reasons.push('INSUFFICIENT_OR_STALE_CLOSED_CONTEXT');
      if (relativeVolume < policy.relativeVolume) reasons.push('RELATIVE_VOLUME_BELOW_THRESHOLD');
      if (Math.abs(aggression) < 0.3) reasons.push('AGGRESSIVE_FLOW_UNCONFIRMED');
      if (!agrees) reasons.push('TREND_CONTEXT_UNCONFIRMED');
      if (!(side === 'LONG' ? breakout : breakdown)) reasons.push('NO_CONFIRMED_PRICE_BREAK');
      if (riskReward === null || riskReward < 2) reasons.push('RISK_REWARD_UNCONFIRMED');
      if (observation.fundingRate !== undefined && Math.abs(observation.fundingRate) > 0.003) reasons.push('EXTREME_FUNDING_CONTEXT');
      if (score < policy.score) reasons.push('SCORE_BELOW_THRESHOLD');
      const key = `${strategy}:${observation.symbol}`;
      if ((this.cooldowns.get(key) ?? 0) > now) reasons.push('SYMBOL_COOLDOWN');
      if (!reasons.length) { classification = 'READY_FOR_RESEARCH'; reasons.push('VOLUME_FLOW_TREND_BREAKOUT_CONFIRMED'); this.cooldowns.set(key, now + policy.cooldownMs); }
    }
    return { id: `${strategy}:${observation.symbol}:${observation.eventTime}:${this.serial++}`, symbol: observation.symbol, strategy,
      classification, side: classification === 'REJECTED' ? 'WAIT' : side, score: rejection ? 0 : score,
      observedAt: now, expiresAt: now + policy.expiryMs, reasons, evidence };
  }
  snapshot(): string {
    return JSON.stringify({ version: 1, serial: this.serial, history: Object.fromEntries(this.history), cooldowns: Object.fromEntries(this.cooldowns),
      epochs: Object.fromEntries(this.epochs), contextSince: Object.fromEntries(this.contextSince) } satisfies EngineState);
  }
  restore(serialized: string) {
    const state = JSON.parse(serialized) as EngineState;
    if (state.version !== 1 || !Number.isSafeInteger(state.serial) || state.serial < 0 || !state.history || !state.cooldowns || !state.epochs || !state.contextSince ||
      Object.keys(state.history).length > 2_000 || Object.keys(state.cooldowns).length > 4_000 ||
      Object.keys(state.epochs).length > 2_000 || Object.keys(state.contextSince).length > 2_000) throw new Error('Invalid research state.');
    const histories = new Map<string, MarketObservation[]>();
    for (const [symbol, history] of Object.entries(state.history)) {
      if (!Array.isArray(history) || history.length > 256 || history.some((value, index) => !validObservation(value) || value.symbol !== symbol ||
        (index > 0 && history[index - 1]!.eventTime >= value.eventTime))) throw new Error('Invalid research history.');
      histories.set(symbol, structuredClone(history));
    }
    if (Object.values(state.cooldowns).some((value) => !finite(value) || value < 0)) throw new Error('Invalid research cooldown.');
    if (Object.values(state.epochs).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      Object.values(state.contextSince).some((value) => !finite(value) || value < 0)) throw new Error('Invalid research epoch.');
    this.history = histories; this.cooldowns = new Map(Object.entries(state.cooldowns)); this.serial = state.serial;
    this.epochs = new Map(Object.entries(state.epochs)); this.contextSince = new Map(Object.entries(state.contextSince));
  }
}
