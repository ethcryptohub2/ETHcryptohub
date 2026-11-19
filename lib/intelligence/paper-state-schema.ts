import { z } from 'zod';
import { validatePaperRiskPolicy } from './risk-governor';

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const timestamp = positive;
const identifier = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const strategy = z.enum(['STANDARD', 'HIGH_RISK']);
const boundedText = z.string().min(1).max(256);
const intent = z.strictObject({
  idempotencyKey: identifier, symbol: z.string().regex(/^[\p{L}\p{N}_]{3,40}$/u),
  side: z.enum(['LONG', 'SHORT']), quantity: positive, entryPrice: positive, stopPrice: positive,
  leverage: positive, estimatedLiquidationPrice: positive, correlationGroup: z.string().min(1).max(64),
});
const risk = z.strictObject({
  allowed: z.boolean(), reasons: z.array(boundedText).max(128), riskAmount: nonnegative,
  notional: nonnegative, marginRequired: nonnegative, evaluatedAt: timestamp,
});
const orderFields = {
  key: identifier, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), signalId: boundedText,
  signalObservedAt: timestamp, signalExpiresAt: timestamp, strategy, intent,
  status: z.enum(['OBSERVED', 'CONFIRMATION_REQUIRED', 'REJECTED', 'RESERVED', 'PARTIAL', 'FILLED', 'CLOSED', 'CANCELLED']),
  risk, reservedAt: timestamp, filledQuantity: nonnegative, averageFillPrice: nonnegative, fees: nonnegative,
  closedAt: timestamp.optional(), realizedPnl: z.number().finite().optional(),
};
const fillResult = z.strictObject({ ...orderFields, fillId: identifier });
const order = z.strictObject({ ...orderFields, fills: z.array(z.strictObject({
  id: identifier, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: fillResult,
})).max(10_000) }).superRefine((value, ctx) => {
  if (value.intent.idempotencyKey !== value.key || value.filledQuantity > value.intent.quantity ||
      new Set(value.fills.map(fill => fill.id)).size !== value.fills.length ||
      value.fills.some(fill => fill.id !== fill.result.fillId || fill.result.key !== value.key)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid durable order identity.' });
  }
});
const policy = z.strictObject({
  riskPerTradePct: positive, maxPortfolioExposurePct: positive, maxCorrelatedExposurePct: positive,
  maxDailyLossPct: positive, maxDrawdownPct: positive, maxPositions: positive.int(), leverageCeiling: positive,
  minLiquidationDistancePct: positive, maxMarketAgeMs: positive, maxConsecutiveLosses: positive.int(),
  lossCooldownMs: positive, symbolExclusions: z.array(z.string()).max(5000), allowedStrategies: z.array(strategy).min(1).max(2),
}).superRefine((value, ctx) => {
  try { validatePaperRiskPolicy(value); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid risk policy.' }); }
});
export const paperStateSchema = z.strictObject({
  version: z.literal(1), revision: positive.int().max(Number.MAX_SAFE_INTEGER),
  tenantId: positive.int().max(Number.MAX_SAFE_INTEGER),
  configuration: z.strictObject({ mode: z.enum(['OBSERVE', 'CONFIRM', 'PAPER_AUTOPILOT']),
    paperVenue: z.enum(['BINANCE', 'BYBIT', 'OKX', 'GATE']), initialEquity: positive.max(1_000_000_000), policy }),
  equity: z.number().finite(), peakEquity: positive, dayStartEquity: z.number().finite(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), realizedDailyPnl: z.number().finite(),
  consecutiveLosses: nonnegative.int(), lastLossAt: timestamp.nullable(),
  killSwitch: z.boolean(), exchangeAvailable: z.boolean(), lastEventAt: timestamp,
  orders: z.array(order).max(10_000),
  audit: z.array(z.strictObject({ sequence: positive.int(), at: timestamp, action: boundedText,
    key: identifier.optional(), reasons: z.array(boundedText).max(128).optional() })).max(50_000),
}).superRefine((value, ctx) => {
  if (new Set(value.orders.map(row => row.key)).size !== value.orders.length ||
      value.audit.some((row, index) => row.sequence > value.revision || row.at > value.lastEventAt ||
        (index > 0 && (row.sequence <= value.audit[index - 1]!.sequence || row.at < value.audit[index - 1]!.at))) ||
      (value.lastLossAt !== null && value.lastLossAt > value.lastEventAt)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid journal ordering or identity.' });
  }
});
