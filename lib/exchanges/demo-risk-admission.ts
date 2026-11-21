import { z } from 'zod';
import { ADMIN_DEMO_PROVIDER_ENVIRONMENTS, ADMIN_DEMO_PROVIDERS } from '../admin-demo-provider-contract';

const unsignedDecimal = z.string().regex(/^\d{1,18}(?:\.\d{1,12})?$/);
const signedDecimal = z.string().regex(/^-?\d{1,18}(?:\.\d{1,12})?$/);
const count = z.number().int().nonnegative().max(10_000);
const symbol = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);
const strategy = z.enum(['STANDARD', 'HIGH_RISK']);
const timestamp = z.number().int().positive().safe();
const scope = z.object({
  adminId: z.number().int().positive().safe(),
  accountId: z.string().uuid(),
  provider: z.enum(ADMIN_DEMO_PROVIDERS),
  environment: z.enum(['DEMO', 'TESTNET']),
}).strict();

const inputSchema = z.object({
  scope,
  now: timestamp,
  policy: z.object({
    maximumNotional: unsignedDecimal,
    maximumPositions: count.min(1),
    maximumDailyOrders: count.min(1),
    maximumDailyLoss: unsignedDecimal,
    allowedSymbols: z.array(symbol).min(1).max(50),
    allowedStrategies: z.array(strategy).min(1).max(2),
  }).strict(),
  account: z.object({
    scope,
    // A verified, complete account snapshot in the same quote currency as the intent.
    observedAt: timestamp,
    utcDay: z.string().regex(/^\d{4}-\d\d-\d\d$/),
    complete: z.literal(true),
    emergencyStop: z.boolean(),
    equity: unsignedDecimal,
    realizedDailyPnl: signedDecimal,
    positions: count,
    reservedEntrySlots: count,
    admittedOrdersToday: count,
    openNotional: unsignedDecimal,
    reservedNotional: unsignedDecimal,
    // Aggregate worst-case remaining loss across positions and reserved entries.
    existingRisk: unsignedDecimal,
  }).strict(),
  intent: z.object({
    symbol,
    strategy,
    side: z.enum(['LONG', 'SHORT']),
    // Must already be normalized from contracts to base asset units.
    quantity: unsignedDecimal,
    entry: unsignedDecimal,
    stop: unsignedDecimal,
  }).strict(),
}).strict();

export type DemoRiskAdmission = { allowed: boolean; reasons: string[] };

const unit = 10n ** 12n;

function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(integer!) * unit + BigInt(fraction.padEnd(12, '0'));
  return negative ? -magnitude : magnitude;
}

/**
 * Evaluates a prepared Demo entry using an authoritative account snapshot.
 * A future caller must lock and reserve its account limits atomically before dispatch.
 */
export function evaluateDemoRiskAdmission(candidate: unknown): DemoRiskAdmission {
  const parsed = inputSchema.safeParse(candidate);
  if (!parsed.success) return { allowed: false, reasons: ['INVALID_OR_INCOMPLETE_RISK_EVIDENCE'] };
  const { account, policy, intent, scope: expected, now } = parsed.data;
  const limit = { notional: units(policy.maximumNotional), dailyLoss: units(policy.maximumDailyLoss) };
  const equity = units(account.equity);
  const quantity = units(intent.quantity);
  const entry = units(intent.entry);
  const stop = units(intent.stop);
  const stopDistance = intent.side === 'LONG' ? entry - stop : stop - entry;
  const maximumJsDate = 8_640_000_000_000_000;
  if ([limit.notional, limit.dailyLoss, equity, quantity, entry, stop, stopDistance].some(value => value <= 0n) ||
      now > maximumJsDate) return { allowed: false, reasons: ['INVALID_LIMITS_OR_ORDER_SIZE'] };

  const reasons = [];
  const observed = account.scope;
  if (expected.environment !== ADMIN_DEMO_PROVIDER_ENVIRONMENTS[expected.provider] ||
      observed.adminId !== expected.adminId || observed.accountId !== expected.accountId ||
      observed.provider !== expected.provider || observed.environment !== expected.environment) {
    reasons.push('ACCOUNT_SCOPE_MISMATCH');
  }
  if (account.emergencyStop) reasons.push('EMERGENCY_STOP');
  if (account.observedAt > now || now - account.observedAt > 10_000 ||
      account.utcDay !== new Date(now).toISOString().slice(0, 10)) reasons.push('STALE_ACCOUNT_EVIDENCE');
  if (!policy.allowedSymbols.includes(intent.symbol)) reasons.push('SYMBOL_NOT_APPROVED');
  if (!policy.allowedStrategies.includes(intent.strategy)) reasons.push('STRATEGY_NOT_APPROVED');
  if (account.positions + account.reservedEntrySlots >= policy.maximumPositions) reasons.push('MAXIMUM_POSITIONS');
  if (account.admittedOrdersToday >= policy.maximumDailyOrders) reasons.push('MAXIMUM_DAILY_ORDERS');

  const newRisk = quantity * stopDistance;
  if (newRisk * 100n > equity * unit) reasons.push('ONE_PERCENT_RISK_LIMIT');
  const openAndReserved = units(account.openNotional) + units(account.reservedNotional);
  if (openAndReserved * unit + quantity * entry > limit.notional * unit) reasons.push('MAXIMUM_NOTIONAL');
  const pnl = units(account.realizedDailyPnl);
  const realizedLoss = pnl < 0n ? -pnl : 0n;
  if (realizedLoss >= limit.dailyLoss ||
      (realizedLoss + units(account.existingRisk)) * unit + newRisk > limit.dailyLoss * unit) {
    reasons.push('DAILY_LOSS_LIMIT');
  }
  return { allowed: reasons.length === 0, reasons };
}
