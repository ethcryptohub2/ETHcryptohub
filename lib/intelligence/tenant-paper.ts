import { createHash } from 'node:crypto';
import type { CustomerPaperMode, MarketObservation, ResearchDecision, ResearchStrategy } from './contracts';
import {
  defaultPaperRiskPolicy, evaluatePaperRisk, validatePaperRiskPolicy,
  type PaperIntent, type PaperRiskAccount, type PaperRiskDecision, type PaperRiskPolicy,
} from './risk-governor';

export interface PaperActor { userId: number; tenantId: number }
export interface PaperConfiguration {
  mode: CustomerPaperMode;
  paperVenue: 'BINANCE' | 'BYBIT' | 'OKX' | 'GATE';
  initialEquity: number;
  policy: PaperRiskPolicy;
}
export type PaperOrderStatus = 'OBSERVED' | 'CONFIRMATION_REQUIRED' | 'REJECTED' | 'RESERVED' | 'PARTIAL' | 'FILLED' | 'CLOSED' | 'CANCELLED';
export interface PaperFillRecord {
  id: string;
  fingerprint: string;
  result: Omit<TenantPaperOrder, 'fills'> & { fillId: string };
}
export interface TenantPaperOrder {
  key: string;
  fingerprint: string;
  signalId: string;
  signalObservedAt: number;
  signalExpiresAt: number;
  strategy: ResearchStrategy;
  intent: PaperIntent;
  status: PaperOrderStatus;
  risk: PaperRiskDecision;
  reservedAt: number;
  filledQuantity: number;
  averageFillPrice: number;
  fees: number;
  fills: PaperFillRecord[];
  closedAt?: number;
  realizedPnl?: number;
}
export interface PaperAuditEvent { sequence: number; at: number; action: string; key?: string; reasons?: string[] }
export interface TenantPaperState {
  version: 1;
  revision: number;
  tenantId: number;
  configuration: PaperConfiguration;
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
  day: string;
  realizedDailyPnl: number;
  consecutiveLosses: number;
  lastLossAt: number | null;
  killSwitch: boolean;
  exchangeAvailable: boolean;
  lastEventAt: number;
  orders: TenantPaperOrder[];
  audit: PaperAuditEvent[];
}
export interface PaperJournal {
  /** Must serialize and atomically persist the entire callback per tenant. */
  transact<T>(tenantId: number, work: (state: TenantPaperState | null) => { state: TenantPaperState; result: T }): Promise<T>;
  read(tenantId: number): Promise<TenantPaperState | null>;
}
export function assertPaperTenant(actor: PaperActor) {
  if (!Number.isSafeInteger(actor?.userId) || actor.userId <= 0 ||
      !Number.isSafeInteger(actor?.tenantId) || actor.tenantId !== actor.userId) {
    throw new Error('Paper account ownership is required.');
  }
}
const active = (order: TenantPaperOrder) => ['RESERVED', 'PARTIAL', 'FILLED'].includes(order.status);
const dayAt = (now: number) => new Date(now).toISOString().slice(0, 10);
function event(state: TenantPaperState, now: number, action: string, key?: string, reasons?: string[]) {
  if (!Number.isFinite(now) || now <= 0 || now < state.lastEventAt) throw new Error('Paper events must use monotonic valid timestamps.');
  state.lastEventAt = now;
  state.revision += 1;
  state.audit.push({ sequence: state.revision, at: now, action, ...(key ? { key } : {}), ...(reasons ? { reasons } : {}) });
  if (state.orders.length > 10_000 || state.audit.length > 50_000) throw new Error('Paper journal capacity reached; archive with an approved retention process.');
}
function requireState(state: TenantPaperState | null, tenantId: number): TenantPaperState {
  if (!state || state.version !== 1 || state.tenantId !== tenantId) throw new Error('Paper account is unavailable.');
  if (!['OBSERVE', 'CONFIRM', 'PAPER_AUTOPILOT'].includes(state.configuration?.mode)) throw new Error('Paper mode is invalid.');
  validatePaperRiskPolicy(state.configuration.policy);
  return state;
}
function account(state: TenantPaperState, market: MarketObservation, now: number, excludeKey?: string): PaperRiskAccount {
  const allOpen = state.orders.filter(active);
  let unrealized = 0;
  let portfolioMarksVerified = true;
  for (const order of allOpen.filter(o => o.filledQuantity > 0)) {
    if (order.intent.symbol !== market.symbol || !market.fresh || !market.sequenceValid ||
        !Number.isFinite(market.eventTime) || !Number.isFinite(market.receivedAt) || market.eventTime > now || market.receivedAt > now ||
        now - market.eventTime > state.configuration.policy.maxMarketAgeMs || now - market.receivedAt > state.configuration.policy.maxMarketAgeMs) {
      portfolioMarksVerified = false;
      continue;
    }
    const price = order.intent.side === 'LONG' ? market.bid : market.ask;
    if (!Number.isFinite(price) || price <= 0 || market.ask < market.bid) { portfolioMarksVerified = false; continue; }
    unrealized += (price - order.averageFillPrice) * order.filledQuantity * (order.intent.side === 'LONG' ? 1 : -1);
  }
  const markedEquity = state.equity + unrealized;
  if (portfolioMarksVerified) state.peakEquity = Math.max(state.peakEquity, markedEquity);
  const open = allOpen.filter(order => order.key !== excludeKey);
  const margin = open.reduce((sum, o) => sum + o.risk.marginRequired, 0);
  return {
    equity: markedEquity, peakEquity: state.peakEquity, dayStartEquity: state.dayStartEquity,
    realizedDailyPnl: state.realizedDailyPnl + unrealized, freeMargin: Math.max(0, markedEquity - margin),
    exchangeAvailable: state.exchangeAvailable, killSwitch: state.killSwitch,
    portfolioMarksVerified,
    consecutiveLosses: state.consecutiveLosses, lastLossAt: state.lastLossAt,
    positions: open.map(o => ({ symbol: o.intent.symbol, notional: Math.max(o.risk.notional,
      o.intent.symbol === market.symbol ? o.filledQuantity * market.price +
        (o.intent.quantity - o.filledQuantity) * o.intent.entryPrice : o.risk.notional),
      riskAmount: o.risk.riskAmount, correlationGroup: o.intent.correlationGroup })),
  };
}
function rollDay(state: TenantPaperState, now: number) {
  if (now < state.lastEventAt) throw new Error('Paper clock moved backwards.');
  if (state.day !== dayAt(now)) {
    state.day = dayAt(now);
    state.dayStartEquity = state.equity;
    state.realizedDailyPnl = 0;
  }
}
function fingerprint(intent: PaperIntent, signalId: string) {
  const stable = [intent.idempotencyKey, intent.symbol, intent.side, intent.quantity, intent.entryPrice,
    intent.stopPrice, intent.leverage, intent.estimatedLiquidationPrice, intent.correlationGroup, signalId];
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export class MemoryPaperJournal implements PaperJournal {
  private rows = new Map<number, TenantPaperState>();
  async transact<T>(tenantId: number, work: (state: TenantPaperState | null) => { state: TenantPaperState; result: T }): Promise<T> {
    // No await inside the transaction: JavaScript execution is synchronous here.
    const update = work(structuredClone(this.rows.get(tenantId) ?? null));
    if (update.state.tenantId !== tenantId) throw new Error('Paper journal tenant mismatch.');
    this.rows.set(tenantId, structuredClone(update.state));
    return structuredClone(update.result);
  }
  async read(tenantId: number) { return structuredClone(this.rows.get(tenantId) ?? null); }
}

/** Pure paper execution only. This class has no exchange transport or credential dependency. */
export class TenantPaperService {
  constructor(private readonly journal: PaperJournal) {}

  async configure(actor: PaperActor, config: PaperConfiguration, now: number) {
    assertPaperTenant(actor);
    if (Object.keys(config).some(k => !['mode', 'paperVenue', 'initialEquity', 'policy'].includes(k)) ||
        !['OBSERVE', 'CONFIRM', 'PAPER_AUTOPILOT'].includes(config.mode) ||
        !['BINANCE', 'BYBIT', 'OKX', 'GATE'].includes(config.paperVenue) ||
        !Number.isFinite(config.initialEquity) || config.initialEquity <= 0 || config.initialEquity > 1_000_000_000) {
      throw new Error('Invalid paper-only configuration; Live Autopilot is unavailable.');
    }
    validatePaperRiskPolicy(config.policy);
    return this.journal.transact(actor.tenantId, existing => {
      const state: TenantPaperState = existing ? requireState(existing, actor.tenantId) : {
        version: 1, revision: 0, tenantId: actor.tenantId, configuration: structuredClone(config),
        equity: config.initialEquity, peakEquity: config.initialEquity, dayStartEquity: config.initialEquity,
        day: dayAt(now), realizedDailyPnl: 0, consecutiveLosses: 0, lastLossAt: null,
        killSwitch: false, exchangeAvailable: true, lastEventAt: now, orders: [], audit: [],
      };
      if (existing && config.initialEquity !== existing.configuration.initialEquity) throw new Error('Paper capital cannot be reset to conceal account losses.');
      state.configuration = structuredClone(config);
      event(state, now, 'CONFIGURATION_UPDATED');
      return { state, result: structuredClone(state.configuration) };
    });
  }

  async inspect(actor: PaperActor) {
    assertPaperTenant(actor);
    return structuredClone(requireState(await this.journal.read(actor.tenantId), actor.tenantId));
  }

  async submit(actor: PaperActor, intent: PaperIntent, market: MarketObservation, signal: ResearchDecision, now: number, confirmation?: string) {
    assertPaperTenant(actor);
    if (typeof signal.id !== 'string' || signal.id.length > 256 || !/^[\p{L}\p{N}_.:-]+$/u.test(signal.id)) {
      throw new Error('Invalid bounded paper research identity.');
    }
    if (Object.keys(intent).some(key => !['idempotencyKey', 'symbol', 'side', 'quantity', 'entryPrice',
      'stopPrice', 'leverage', 'estimatedLiquidationPrice', 'correlationGroup'].includes(key))) {
      throw new Error('Unsupported paper intent field; credentials are never accepted.');
    }
    return this.journal.transact(actor.tenantId, existing => {
      const state = requireState(existing, actor.tenantId);
      rollDay(state, now);
      const key = intent.idempotencyKey;
      const digest = fingerprint(intent, signal.id);
      const previous = state.orders.find(o => o.key === key);
      if (previous) {
        if (previous.fingerprint !== digest) throw new Error('Paper idempotency key conflicts with a different intent.');
        if (previous.status === 'CONFIRMATION_REQUIRED' && state.configuration.mode === 'CONFIRM' && confirmation === `CONFIRM_PAPER:${key}`) {
          const risk = evaluatePaperRisk({ policy: state.configuration.policy, account: account(state, market, now), intent, market, signal, now });
          previous.risk = risk;
          previous.status = risk.allowed ? 'RESERVED' : 'REJECTED';
          previous.reservedAt = now;
          event(state, now, previous.status, key, risk.reasons);
        }
        return { state, result: structuredClone(previous) };
      }
      const risk = evaluatePaperRisk({ policy: state.configuration.policy, account: account(state, market, now), intent, market, signal, now });
      const mode = state.configuration.mode;
      const status: PaperOrderStatus = !risk.allowed ? 'REJECTED' : mode === 'OBSERVE' ? 'OBSERVED'
        : mode === 'CONFIRM' && confirmation !== `CONFIRM_PAPER:${key}` ? 'CONFIRMATION_REQUIRED' : 'RESERVED';
      const order: TenantPaperOrder = { key, fingerprint: digest, signalId: signal.id,
        signalObservedAt: signal.observedAt, signalExpiresAt: signal.expiresAt, strategy: signal.strategy,
        intent: structuredClone(intent), status, risk, reservedAt: now, filledQuantity: 0, averageFillPrice: 0, fees: 0, fills: [] };
      state.orders.push(order);
      event(state, now, status, key, risk.reasons);
      return { state, result: structuredClone(order) };
    });
  }

  async fill(actor: PaperActor, key: string, fillId: string, quantity: number, market: MarketObservation, now: number, feeBps = 4) {
    assertPaperTenant(actor);
    if (typeof fillId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(fillId)) throw new Error('A bounded durable paper fill identity is required.');
    return this.journal.transact(actor.tenantId, existing => {
      const state = requireState(existing, actor.tenantId);
      const order = state.orders.find(o => o.key === key);
      if (!order) throw new Error('Paper fill requires an unfilled reservation.');
      if (!Array.isArray(order.fills)) throw new Error('Paper journal lacks durable fill identities; reviewed recovery is required.');
      const fillFingerprint = createHash('sha256').update(JSON.stringify([
        key, fillId, quantity, feeBps, market.symbol, market.source, market.bid, market.ask, market.eventTime,
      ])).digest('hex');
      const previous = order.fills.find(fill => fill.id === fillId);
      if (previous) {
        if (previous.fingerprint !== fillFingerprint) throw new Error('Paper fill identity conflicts with a different fill.');
        return { state, result: structuredClone(previous.result) };
      }
      rollDay(state, now);
      if (!['RESERVED', 'PARTIAL'].includes(order.status)) throw new Error('Paper fill requires an unfilled reservation.');
      if (state.configuration.mode === 'OBSERVE') throw new Error('Paper fills are disabled in Observe mode.');
      if (state.killSwitch || !state.exchangeAvailable) throw new Error('Paper fills are paused by risk controls.');
      const gate = evaluatePaperRisk({ policy: state.configuration.policy, account: account(state, market, now, key),
        intent: order.intent, market, now, signal: {
          id: order.signalId, symbol: order.intent.symbol, strategy: order.strategy,
          classification: 'READY_FOR_RESEARCH', side: order.intent.side, score: 0,
          observedAt: order.signalObservedAt, expiresAt: order.signalExpiresAt, reasons: [], evidence: {},
        } });
      if (!gate.allowed) throw new Error(`Paper fill rejected: ${gate.reasons.join(',')}`);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > order.intent.quantity - order.filledQuantity ||
          !Number.isFinite(feeBps) || feeBps < 0 || feeBps > 100 || !market.fresh || !market.sequenceValid ||
          market.source !== 'BINANCE_USDM' || !Number.isFinite(market.eventTime) || !Number.isFinite(market.receivedAt) ||
          market.symbol !== order.intent.symbol || market.eventTime > now || market.receivedAt > now ||
          now - market.eventTime > state.configuration.policy.maxMarketAgeMs || now - market.receivedAt > state.configuration.policy.maxMarketAgeMs) {
        throw new Error('Invalid or stale paper fill.');
      }
      const price = order.intent.side === 'LONG' ? market.ask : market.bid;
      if (!Number.isFinite(price) || price <= 0 || market.ask < market.bid ||
          (order.intent.side === 'LONG' ? price > order.intent.entryPrice : price < order.intent.entryPrice)) {
        throw new Error('Paper limit price was not reached.');
      }
      const total = order.filledQuantity + quantity;
      order.averageFillPrice = (order.averageFillPrice * order.filledQuantity + price * quantity) / total;
      order.filledQuantity = total;
      const fee = price * quantity * feeBps / 10_000;
      order.fees += fee;
      state.equity -= fee;
      state.realizedDailyPnl -= fee;
      order.status = total === order.intent.quantity ? 'FILLED' : 'PARTIAL';
      event(state, now, 'PAPER_FILL', key);
      const result = structuredClone({
        key: order.key, fingerprint: order.fingerprint, signalId: order.signalId,
        signalObservedAt: order.signalObservedAt, signalExpiresAt: order.signalExpiresAt,
        strategy: order.strategy, intent: order.intent, status: order.status, risk: order.risk,
        reservedAt: order.reservedAt, filledQuantity: order.filledQuantity,
        averageFillPrice: order.averageFillPrice, fees: order.fees, fillId,
      });
      order.fills.push({ id: fillId, fingerprint: fillFingerprint, result });
      return { state, result: structuredClone(result) };
    });
  }

  async close(actor: PaperActor, key: string, market: MarketObservation, now: number, feeBps = 4) {
    assertPaperTenant(actor);
    return this.journal.transact(actor.tenantId, existing => {
      const state = requireState(existing, actor.tenantId);
      rollDay(state, now);
      const order = state.orders.find(o => o.key === key);
      if (!order || !active(order) || order.filledQuantity <= 0) throw new Error('No filled paper position is available.');
      if (!market.fresh || !market.sequenceValid || market.symbol !== order.intent.symbol || market.source !== 'BINANCE_USDM' ||
          !Number.isFinite(market.eventTime) || !Number.isFinite(market.receivedAt) || market.eventTime > now || market.receivedAt > now ||
          now - market.eventTime > state.configuration.policy.maxMarketAgeMs || now - market.receivedAt > state.configuration.policy.maxMarketAgeMs ||
          !Number.isFinite(feeBps) || feeBps < 0 || feeBps > 100) throw new Error('A fresh valid paper close quote is required.');
      const price = order.intent.side === 'LONG' ? market.bid : market.ask;
      if (!Number.isFinite(price) || price <= 0 || market.ask < market.bid) throw new Error('Invalid paper close quote.');
      const fee = price * order.filledQuantity * feeBps / 10_000;
      const pnl = (price - order.averageFillPrice) * order.filledQuantity * (order.intent.side === 'LONG' ? 1 : -1) - fee;
      state.equity += pnl;
      state.realizedDailyPnl += pnl;
      state.peakEquity = Math.max(state.peakEquity, state.equity);
      order.fees += fee;
      order.realizedPnl = pnl - (order.fees - fee);
      order.closedAt = now;
      order.status = 'CLOSED';
      if (order.realizedPnl < 0) { state.consecutiveLosses += 1; state.lastLossAt = now; }
      else state.consecutiveLosses = 0;
      event(state, now, 'PAPER_CLOSE', key);
      return { state, result: structuredClone(order) };
    });
  }

  async cancel(actor: PaperActor, key: string, now: number) {
    assertPaperTenant(actor);
    return this.journal.transact(actor.tenantId, existing => {
      const state = requireState(existing, actor.tenantId);
      const order = state.orders.find(o => o.key === key);
      if (!order || order.status !== 'RESERVED' || order.filledQuantity !== 0) throw new Error('Only an entirely unfilled paper reservation can be cancelled.');
      order.status = 'CANCELLED';
      event(state, now, 'PAPER_CANCEL', key);
      return { state, result: true };
    });
  }

  async setSafety(actor: PaperActor, safety: { killSwitch: boolean; exchangeAvailable: boolean }, now: number) {
    assertPaperTenant(actor);
    if (typeof safety.killSwitch !== 'boolean' || typeof safety.exchangeAvailable !== 'boolean') throw new Error('Invalid paper safety state.');
    return this.journal.transact(actor.tenantId, existing => {
      const state = requireState(existing, actor.tenantId);
      state.killSwitch = safety.killSwitch;
      state.exchangeAvailable = safety.exchangeAvailable;
      event(state, now, 'SAFETY_UPDATED');
      return { state, result: { killSwitch: state.killSwitch, exchangeAvailable: state.exchangeAvailable } };
    });
  }
}

export function defaultPaperConfiguration(): PaperConfiguration {
  return { mode: 'OBSERVE', paperVenue: 'BINANCE', initialEquity: 10_000, policy: defaultPaperRiskPolicy() };
}

/** Verification result only; it neither provisions tables nor grants access. */
export function verifyPaperDatabaseIsolation(evidence: readonly {
  table: string;
  rowSecurity: boolean;
  forcedRowSecurity: boolean;
  tenantConstraint?: boolean;
  browserGrants: readonly string[];
}[]) {
  const required = ['paper_account_states', 'research_decisions'];
  const failures: string[] = [];
  for (const table of required) {
    const rows = evidence.filter(item => item.table === table);
    if (rows.length !== 1) { failures.push(`${table}:MISSING_OR_AMBIGUOUS`); continue; }
    const row = rows[0]!;
    if (row.rowSecurity !== true) failures.push(`${table}:RLS_DISABLED`);
    if (row.forcedRowSecurity !== true) failures.push(`${table}:FORCED_RLS_DISABLED`);
    if (table === 'paper_account_states' && row.tenantConstraint !== true) failures.push(`${table}:TENANT_CONSTRAINT_MISSING`);
    if (!Array.isArray(row.browserGrants) || !row.browserGrants.every(role => typeof role === 'string')) {
      failures.push(`${table}:GRANT_EVIDENCE_MISSING`);
    } else if (row.browserGrants.some(role => ['public', 'anon', 'authenticated'].includes(role.toLowerCase()))) {
      failures.push(`${table}:BROWSER_GRANT`);
    }
  }
  return { verified: failures.length === 0, failures };
}
