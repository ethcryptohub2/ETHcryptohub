import type { MarketObservation, ResearchDecision, ResearchStrategy } from './contracts';
import { MemoryResearchJournal, ResearchEngine, type ClosedBar } from './research-engine';

export type ResearchReplayEvent =
  | { type: 'BAR'; at: number; symbol: string; bar: ClosedBar }
  | { type: 'OBSERVATION'; at: number; observation: MarketObservation }
  | { type: 'TRADE'; at: number; symbol: string; price: number; quantity: number }
  | { type: 'FUNDING'; at: number; symbol: string; markPrice: number; rate: number };
export interface ReplayOptions {
  initialEquity?: number; feeBps?: number; slippageBps?: number; spreadBps?: number;
  latencyMs?: number; participation?: number; allocationFraction?: number; maxHoldingMs?: number;
  warmupEvents?: readonly ResearchReplayEvent[];
}
export interface PaperReplayFill {
  at: number; strategy: ResearchStrategy; symbol: string; direction: 'BUY' | 'SELL';
  quantity: number; price: number; fee: number; reason: 'ENTRY' | 'STOP' | 'TARGET' | 'MAX_HOLD';
}
interface Position {
  symbol: string; side: 'LONG' | 'SHORT'; quantity: number; entry: number; openedAt: number;
  stop: number; target: number; entryFees: number; funding: number; accumulatedNet: number;
  exitReason?: 'STOP' | 'TARGET' | 'MAX_HOLD';
  exitReadyAt?: number;
}
interface Pending { decision: ResearchDecision; quantity: number; stop: number; target: number; readyAt: number }
interface StrategyAccount {
  cash: number; position: Position | null; pending: Pending | null; completed: number[];
  fills: PaperReplayFill[]; equity: Array<{ at: number; equity: number }>; maxDrawdown: number;
  peak: number; fees: number; funding: number; rejectedEntries: number;
}
const strategies = ['STANDARD', 'HIGH_RISK'] as const;
function configuration(options: ReplayOptions) {
  const config = { initialEquity: options.initialEquity ?? 10_000, feeBps: options.feeBps ?? 4,
    slippageBps: options.slippageBps ?? 2, spreadBps: options.spreadBps ?? 2, latencyMs: options.latencyMs ?? 100,
    participation: options.participation ?? 0.1, allocationFraction: options.allocationFraction ?? 0.1,
    maxHoldingMs: options.maxHoldingMs ?? 300_000 };
  if (Object.values(config).some((value) => !Number.isFinite(value)) || config.initialEquity <= 0 ||
    [config.feeBps, config.slippageBps, config.spreadBps].some((value) => value < 0 || value > 100) ||
    config.latencyMs < 0 || config.latencyMs > 60_000 || config.participation <= 0 || config.participation > 1 ||
    config.allocationFraction <= 0 || config.allocationFraction > 1 || config.maxHoldingMs <= 0) throw new Error('Invalid replay assumptions.');
  return config;
}
function validateEvents(events: readonly ResearchReplayEvent[]) {
  if (events.length > 100_000) throw new Error('Replay exceeds bounded event capacity.');
  let previous = -Infinity;
  for (const event of events) {
    if (!Number.isFinite(event.at) || event.at < 0 || event.at < previous) throw new Error('Replay must use ordered event availability times.');
    previous = event.at;
    if (event.type === 'BAR') {
      if (!Number.isFinite(event.bar.availableAt) || !Number.isFinite(event.bar.closeTime) ||
        event.bar.availableAt > event.at || event.bar.closeTime > event.at) throw new Error('Look-ahead bar is forbidden.');
    } else if (event.type === 'TRADE') {
      if (![event.price, event.quantity].every(Number.isFinite) || event.price <= 0 || event.quantity < 0) throw new Error('Invalid replay trade.');
    } else if (event.type === 'FUNDING') {
      if (![event.markPrice, event.rate].every(Number.isFinite) || event.markPrice <= 0 || Math.abs(event.rate) > 0.1) throw new Error('Invalid funding event.');
    } else if (event.type !== 'OBSERVATION') throw new Error('Unknown replay event.');
  }
}

/** Independent hypothetical accounts per strategy; never connects to an exchange. */
export function replayResearch(events: readonly ResearchReplayEvent[], options: ReplayOptions = {}) {
  const config = configuration(options);
  validateEvents(events);
  const warmup = options.warmupEvents ?? [];
  validateEvents(warmup);
  if (warmup.length && events.length && warmup.at(-1)!.at > events[0]!.at) throw new Error('Warmup cannot include future test data.');
  const journal = new MemoryResearchJournal(100_000);
  const engine = new ResearchEngine(journal);
  const bars = new Map<string, ClosedBar[]>();
  const marks = new Map<string, number>();
  const account = (): StrategyAccount => ({
    cash: config.initialEquity, position: null, pending: null, completed: [], fills: [], equity: [],
    maxDrawdown: 0, peak: config.initialEquity, fees: 0, funding: 0, rejectedEntries: 0,
  });
  const accounts: Record<ResearchStrategy, StrategyAccount> = { STANDARD: account(), HIGH_RISK: account() };
  const decisions: ResearchDecision[] = [];
  const signed = (side: 'LONG' | 'SHORT') => side === 'LONG' ? 1 : -1;
  const executionPrice = (price: number, direction: 'BUY' | 'SELL') => price *
    (1 + (direction === 'BUY' ? 1 : -1) * (config.slippageBps + config.spreadBps / 2) / 10_000);
  function recordEquity(at: number) {
    for (const strategy of strategies) {
      const account = accounts[strategy]; const position = account.position;
      const unrealized = position ? signed(position.side) * ((marks.get(position.symbol) ?? position.entry) - position.entry) * position.quantity : 0;
      const equity = account.cash + unrealized;
      account.peak = Math.max(account.peak, equity);
      account.maxDrawdown = Math.max(account.maxDrawdown, account.peak > 0 ? (account.peak - equity) / account.peak : 0);
      account.equity.push({ at, equity });
    }
  }
  function context(event: ResearchReplayEvent) {
    if (event.type === 'BAR') {
      const history = bars.get(event.symbol) ?? [];
      history.push(structuredClone(event.bar)); bars.set(event.symbol, history.slice(-256));
    } else if (event.type === 'OBSERVATION') {
      return engine.ingest(event.observation, event.at, { bars: bars.get(event.observation.symbol) ?? [] });
    }
    return [];
  }
  for (const event of warmup) context(event);
  for (const event of events) {
    const evaluated = context(event);
    if (event.type === 'OBSERVATION' && evaluated.length && !evaluated.some((decision) =>
      decision.reasons.includes('INVALID_OR_STALE_REQUIRED_DATA') || decision.reasons.includes('DUPLICATE_OR_OUT_OF_ORDER_EVENT'))) {
      marks.set(event.observation.symbol, event.observation.price);
    }
    for (const decision of evaluated) {
      decisions.push(decision);
      const account = accounts[decision.strategy];
      if (decision.classification !== 'READY_FOR_RESEARCH' || account.position || account.pending || account.cash <= 0) continue;
      const { entry, stop, target } = decision.evidence;
      if (typeof entry !== 'number' || typeof stop !== 'number' || typeof target !== 'number' || entry <= 0 ||
        ![entry, stop, target].every(Number.isFinite)) { account.rejectedEntries++; continue; }
      const quantity = Math.min(account.cash * config.allocationFraction / entry, account.cash * 0.01 / Math.abs(entry - stop));
      if (!Number.isFinite(quantity) || quantity <= 0) { account.rejectedEntries++; continue; }
      account.pending = { decision, quantity, stop, target, readyAt: event.at + config.latencyMs };
    }
    if (event.type === 'TRADE') {
      marks.set(event.symbol, event.price);
      for (const strategy of strategies) {
        const account = accounts[strategy]; let available = event.quantity * config.participation;
        const position = account.position;
        if (position?.symbol === event.symbol) {
          if (!position.exitReason) {
            const stopped = position.side === 'LONG' ? event.price <= position.stop : event.price >= position.stop;
            const targeted = position.side === 'LONG' ? event.price >= position.target : event.price <= position.target;
            if (stopped) position.exitReason = 'STOP';
            else if (targeted) position.exitReason = 'TARGET';
            else if (event.at - position.openedAt >= config.maxHoldingMs) position.exitReason = 'MAX_HOLD';
            if (position.exitReason) position.exitReadyAt = event.at + config.latencyMs;
          }
          if (position.exitReason) {
            // Stop/exit intent latches across partial fills and later price recovery.
            account.pending = null;
            const quantity = event.at >= position.exitReadyAt! ? Math.min(position.quantity, available) : 0;
            if (quantity > 0) {
              const direction = position.side === 'LONG' ? 'SELL' : 'BUY';
              const price = executionPrice(event.price, direction);
              const fee = price * quantity * config.feeBps / 10_000;
              const fraction = quantity / position.quantity;
              const entryFees = position.entryFees * fraction; const funding = position.funding * fraction;
              const gross = signed(position.side) * (price - position.entry) * quantity;
              account.cash += gross - fee; account.fees += fee;
              position.accumulatedNet += gross - fee - entryFees - funding;
              position.entryFees -= entryFees; position.funding -= funding; position.quantity -= quantity; available -= quantity;
              account.fills.push({ at: event.at, strategy, symbol: event.symbol, direction, quantity, price, fee, reason: position.exitReason });
              if (position.quantity < 1e-12) { account.completed.push(position.accumulatedNet); account.position = null; }
            }
          }
        }
        const pending = account.pending;
        if (pending && pending.decision.expiresAt <= event.at) { account.pending = null; account.rejectedEntries++; }
        else if (pending && pending.decision.symbol === event.symbol && event.at >= pending.readyAt && available > 0) {
          const side = pending.decision.side;
          if (side === 'WAIT' || (side === 'LONG' ? event.price <= pending.stop || event.price >= pending.target : event.price >= pending.stop || event.price <= pending.target)) {
            account.pending = null; account.rejectedEntries++; continue;
          }
          const direction = side === 'LONG' ? 'BUY' : 'SELL';
          const price = executionPrice(event.price, direction);
          if (side === 'LONG' ? price <= pending.stop || price >= pending.target : price >= pending.stop || price <= pending.target) {
            account.pending = null; account.rejectedEntries++; continue;
          }
          const quantity = Math.min(pending.quantity, available, Math.max(0, account.cash) * config.allocationFraction / price);
          if (quantity <= 0) continue;
          const fee = quantity * price * config.feeBps / 10_000;
          const existing = account.position;
          if (existing) {
            existing.entry = (existing.entry * existing.quantity + price * quantity) / (existing.quantity + quantity);
            existing.quantity += quantity; existing.entryFees += fee;
          } else account.position = { symbol: event.symbol, side, quantity, entry: price, openedAt: event.at,
            stop: pending.stop, target: pending.target, entryFees: fee, funding: 0, accumulatedNet: 0 };
          pending.quantity -= quantity; account.cash -= fee; account.fees += fee;
          account.fills.push({ at: event.at, strategy, symbol: event.symbol, direction, quantity, price, fee, reason: 'ENTRY' });
          if (pending.quantity < 1e-12) account.pending = null;
        }
      }
    } else if (event.type === 'FUNDING') {
      for (const strategy of strategies) {
        const account = accounts[strategy]; const position = account.position;
        if (position?.symbol !== event.symbol) continue;
        const cost = signed(position.side) * position.quantity * event.markPrice * event.rate;
        account.cash -= cost; account.funding += cost; position.funding += cost;
      }
    }
    recordEquity(event.at);
  }
  const durationHours = events.length > 1 ? Math.max(1 / 3_600_000, (events.at(-1)!.at - events[0]!.at) / 3_600_000) : 0;
  const reports = Object.fromEntries(strategies.map((strategy) => {
    const account = accounts[strategy]; const outcomes = account.completed;
    const gains = outcomes.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = -outcomes.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
    const classifications = decisions.filter((decision) => decision.strategy === strategy);
    const watch = classifications.filter((decision) => decision.classification === 'WATCH');
    const missedOpportunityProxies = watch.filter((decision) => {
      const entry = decision.evidence.entry; const stop = decision.evidence.stop;
      if (typeof entry !== 'number' || typeof stop !== 'number' || Math.abs(entry - stop) <= 0) return false;
      return events.some((event) => event.type === 'TRADE' && event.symbol === decision.symbol && event.at > decision.observedAt &&
        event.at <= decision.expiresAt && (decision.side === 'LONG' ? event.price - entry : entry - event.price) >= Math.abs(entry - stop));
    }).length;
    return [strategy, {
      initialEquity: config.initialEquity, finalEquity: account.equity.at(-1)?.equity ?? config.initialEquity,
      realizedCash: account.cash, completedTrades: outcomes.length, openPositions: account.position ? 1 : 0,
      netExpectancy: outcomes.length ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length : null,
      profitFactor: losses > 0 ? gains / losses : null, profitFactorReason: losses === 0 ? 'NO_REALIZED_LOSSES_DENOMINATOR' : null,
      maxDrawdownFraction: account.maxDrawdown, fees: account.fees, fundingCost: account.funding,
      tradeFrequencyPerHour: durationHours > 0 ? outcomes.length / durationHours : 0,
      opportunityFrequencyPerHour: durationHours > 0 ? classifications.filter((decision) => decision.classification === 'READY_FOR_RESEARCH').length / durationHours : 0,
      rejectedEntries: account.rejectedEntries, missedOpportunityProxies,
      missedOpportunityDefinition: 'WATCH observations followed by a >=1R favorable move before research expiry; not proof of an executable or profitable missed trade.',
      classificationCounts: Object.fromEntries(['WATCH', 'READY_FOR_RESEARCH', 'REJECTED'].map((value) => [value, classifications.filter((decision) => decision.classification === value).length])),
      fills: account.fills, equityCurve: account.equity,
    }];
  }));
  return { simulation: true as const, realExchangePerformance: false as const,
    assumptions: config, lookAheadPrevention: 'ORDERED_EVENT_AVAILABILITY', strategyCapital: 'INDEPENDENT_HYPOTHETICAL_ACCOUNTS',
    reports, decisions, evidenceJournal: journal.serialize() };
}

/** Fixed-policy chronological comparison; no claim of parameter optimization or statistical significance. */
export function walkForwardEvaluation(events: readonly ResearchReplayEvent[], options: ReplayOptions & { trainingEvents: number; testEvents: number }) {
  const { trainingEvents, testEvents, ...replayOptions } = options;
  if (!Number.isInteger(trainingEvents) || !Number.isInteger(testEvents) || trainingEvents < 1 || testEvents < 1) throw new Error('Invalid walk-forward windows.');
  validateEvents(events);
  const windows = [];
  for (let offset = 0; offset + trainingEvents + testEvents <= events.length; offset += testEvents) {
    const training = events.slice(offset, offset + trainingEvents);
    const test = events.slice(offset + trainingEvents, offset + trainingEvents + testEvents);
    windows.push({ trainingStart: training[0]!.at, trainingEnd: training.at(-1)!.at, testStart: test[0]!.at, testEnd: test.at(-1)!.at,
      training: replayResearch(training, replayOptions).reports,
      outOfSample: replayResearch(test, { ...replayOptions, warmupEvents: training }).reports });
  }
  return { simulation: true as const, evaluation: 'FIXED_POLICY_WALK_FORWARD', windows };
}
