import { z } from 'zod';

export const aiShadowAgents = [
  'MARKET_STRUCTURE', 'LIQUIDITY_SWEEP', 'VOLUME_MOMENTUM',
  'NEWS_SENTIMENT', 'SIGNAL_VALIDATION', 'RISK_GUARDIAN',
] as const;

const strategy = z.enum(['STANDARD', 'HIGH_RISK']);
const regime = z.enum(['TRENDING_UP', 'TRENDING_DOWN', 'RANGE', 'VOLATILE', 'UNKNOWN']);
const decision = z.enum(['APPROVE', 'REJECT', 'NEEDS_REVIEW']);
const provider = z.enum(['GEMINI', 'CLAUDE', 'OPENAI']);
const agent = z.enum(aiShadowAgents);
const time = z.iso.datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const signalId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const version = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);
const sources = z.enum(['CLOSED_FUTURES_CANDLE', 'FUTURES_ORDER_BOOK', 'FUTURES_TRADES', 'APPROVED_NEWS', 'DETERMINISTIC_SCAN']);
const metrics = [
  'EMA_STACK', 'SUPERTREND_DIRECTION', 'CANDLE_CLOSE', 'BOOK_SPREAD_BPS', 'BID_DEPTH_QUOTE',
  'ASK_DEPTH_QUOTE', 'TAKER_IMBALANCE', 'RELATIVE_VOLUME', 'RSI', 'NEWS_ARTICLE_COUNT',
  'NEWS_SENTIMENT_SCORE', 'SCAN_SCORE', 'STOP_DISTANCE_BPS', 'REWARD_RISK_RATIO',
] as const;
const metric = z.enum(metrics);
type Metric = z.infer<typeof metric>;
type Source = z.infer<typeof sources>;
type Agent = z.infer<typeof agent>;

const sourceByMetric: Record<Metric, Source> = {
  EMA_STACK: 'CLOSED_FUTURES_CANDLE',
  SUPERTREND_DIRECTION: 'CLOSED_FUTURES_CANDLE',
  CANDLE_CLOSE: 'CLOSED_FUTURES_CANDLE',
  BOOK_SPREAD_BPS: 'FUTURES_ORDER_BOOK',
  BID_DEPTH_QUOTE: 'FUTURES_ORDER_BOOK',
  ASK_DEPTH_QUOTE: 'FUTURES_ORDER_BOOK',
  TAKER_IMBALANCE: 'FUTURES_TRADES',
  RELATIVE_VOLUME: 'CLOSED_FUTURES_CANDLE',
  RSI: 'CLOSED_FUTURES_CANDLE',
  NEWS_ARTICLE_COUNT: 'APPROVED_NEWS',
  NEWS_SENTIMENT_SCORE: 'APPROVED_NEWS',
  SCAN_SCORE: 'DETERMINISTIC_SCAN',
  STOP_DISTANCE_BPS: 'DETERMINISTIC_SCAN',
  REWARD_RISK_RATIO: 'DETERMINISTIC_SCAN',
};

const requiredByAgent: Record<Agent, readonly Metric[]> = {
  MARKET_STRUCTURE: ['EMA_STACK', 'SUPERTREND_DIRECTION', 'CANDLE_CLOSE'],
  LIQUIDITY_SWEEP: ['BOOK_SPREAD_BPS', 'BID_DEPTH_QUOTE', 'ASK_DEPTH_QUOTE', 'TAKER_IMBALANCE'],
  VOLUME_MOMENTUM: ['RELATIVE_VOLUME', 'RSI'],
  NEWS_SENTIMENT: ['NEWS_ARTICLE_COUNT', 'NEWS_SENTIMENT_SCORE'],
  SIGNAL_VALIDATION: ['SCAN_SCORE', 'CANDLE_CLOSE', 'REWARD_RISK_RATIO'],
  RISK_GUARDIAN: ['STOP_DISTANCE_BPS', 'REWARD_RISK_RATIO', 'BOOK_SPREAD_BPS'],
};

const maxEvidenceAgeMs: Record<Source, number> = {
  CLOSED_FUTURES_CANDLE: 5 * 60_000,
  FUTURES_ORDER_BOOK: 10_000,
  FUTURES_TRADES: 60_000,
  APPROVED_NEWS: 24 * 60 * 60_000,
  DETERMINISTIC_SCAN: 60_000,
};

const evidenceSchema = z.strictObject({
  metric, source: sources, observedAt: time, value: z.number().finite(),
});
const evidenceInput = z.strictObject({
  candidateSignalId: signalId, strategy, symbol: z.string().regex(/^[A-Z0-9]{2,28}USDT$/),
  side: z.enum(['LONG', 'SHORT']), evaluatedAt: time, observations: z.array(evidenceSchema).max(metrics.length),
});

function isPlausible(metricName: Metric, value: number): boolean {
  switch (metricName) {
    case 'EMA_STACK':
    case 'SUPERTREND_DIRECTION': return value === -1 || value === 0 || value === 1;
    case 'RSI':
    case 'SCAN_SCORE': return value >= 0 && value <= 100;
    case 'TAKER_IMBALANCE':
    case 'NEWS_SENTIMENT_SCORE': return value >= -1 && value <= 1;
    case 'NEWS_ARTICLE_COUNT': return Number.isSafeInteger(value) && value >= 0;
    case 'CANDLE_CLOSE':
    case 'STOP_DISTANCE_BPS':
    case 'REWARD_RISK_RATIO': return value > 0;
    default: return value >= 0;
  }
}

export function normalizeAiShadowEvidence(input: unknown) {
  const { observations, ...candidate } = evidenceInput.parse(input);
  const cutoff = Date.parse(candidate.evaluatedAt);
  const seen = new Set<Metric>();
  const usable = observations.filter(({ metric: name, source, observedAt, value }) => {
    const observed = Date.parse(observedAt);
    if (seen.has(name) || source !== sourceByMetric[name] || observed > cutoff || !isPlausible(name, value)) {
      throw new Error('Invalid AI shadow evidence.');
    }
    seen.add(name);
    return cutoff - observed <= maxEvidenceAgeMs[source];
  });
  return {
    ...candidate, evaluatedAt: new Date(cutoff).toISOString(),
    observations: usable.map((entry) => ({ ...entry, observedAt: new Date(entry.observedAt).toISOString() }))
      .sort((a, b) => a.metric.localeCompare(b.metric)),
  };
}

export type AiShadowEvidence = ReturnType<typeof normalizeAiShadowEvidence>;
const identity = z.strictObject({ agent, provider, model: version, promptVersion: version });
type AgentIdentity = z.infer<typeof identity>;
type EvidenceContext = Readonly<AiShadowEvidence>;

export function buildAiShadowReview(evidence: EvidenceContext, requestedIdentity: AgentIdentity) {
  const reviewIdentity = identity.parse(requestedIdentity);
  const normalized = normalizeAiShadowEvidence(evidence);
  const available = new Set(normalized.observations.map((entry) => entry.metric));
  return {
    ...normalized, ...reviewIdentity,
    missingEvidence: requiredByAgent[reviewIdentity.agent].filter((name) => !available.has(name)),
    mode: 'SHADOW' as const,
  };
}

const evidenceReference = z.strictObject({
  metric, observedAt: time, explanation: z.string().trim().min(1).max(300),
});
export const aiShadowDecisionSchema = identity.extend({
  candidateSignalId: signalId, strategy, marketRegime: regime,
  evidenceAsOf: time, supportingFactors: z.array(evidenceReference).max(metrics.length),
  conflictingFactors: z.array(evidenceReference).max(metrics.length), missingEvidence: z.array(metric).max(metrics.length),
  decision, explanation: z.string().trim().min(1).max(800),
});

export type AiShadowDecision = z.infer<typeof aiShadowDecisionSchema>;

export function validateAiShadowDecision(input: unknown, evidence: EvidenceContext, requestedIdentity: AgentIdentity) {
  const expected = buildAiShadowReview(evidence, requestedIdentity);
  const result = aiShadowDecisionSchema.parse(input);
  if (result.agent !== expected.agent || result.provider !== expected.provider || result.model !== expected.model ||
      result.promptVersion !== expected.promptVersion || result.candidateSignalId !== expected.candidateSignalId ||
      result.strategy !== expected.strategy || Date.parse(result.evidenceAsOf) !== Date.parse(expected.evaluatedAt)) {
    throw new Error('AI shadow decision does not match the candidate, evidence or configured agent.');
  }
  const observed = new Map(expected.observations.map((entry) => [entry.metric, Date.parse(entry.observedAt)]));
  const referenced = new Set<Metric>();
  for (const factor of [...result.supportingFactors, ...result.conflictingFactors]) {
    if (referenced.has(factor.metric) || observed.get(factor.metric) !== Date.parse(factor.observedAt)) {
      throw new Error('AI shadow decision cites duplicate, missing or mismatched evidence.');
    }
    referenced.add(factor.metric);
  }
  const missing = new Set(result.missingEvidence);
  if (missing.size !== result.missingEvidence.length || [...missing].some((name) => observed.has(name)) ||
      expected.missingEvidence.some((name) => !missing.has(name))) {
    throw new Error('AI shadow decision misstates required or available evidence.');
  }
  if (result.decision === 'APPROVE' && (missing.size > 0 || result.supportingFactors.length === 0)) {
    throw new Error('AI shadow approval requires supporting evidence and no missing evidence.');
  }
  return result;
}

export function summarizeAiShadowReviews(
  evidence: EvidenceContext,
  reviews: readonly { identity: AgentIdentity; response: unknown }[],
) {
  if (reviews.length > aiShadowAgents.length) throw new Error('Too many AI shadow reviews.');
  const validated = new Map<Agent, AiShadowDecision>();
  for (const review of reviews) {
    const result = validateAiShadowDecision(review.response, evidence, review.identity);
    if (validated.has(result.agent)) throw new Error('Duplicate AI shadow agent review.');
    validated.set(result.agent, result);
  }
  const missingAgents = aiShadowAgents.filter((name) => !validated.has(name));
  const decisions = aiShadowAgents.flatMap((name) => validated.get(name) ?? []);
  return {
    mode: 'SHADOW' as const,
    executionEligible: false as const,
    missingAgents,
    decisions,
  };
}
