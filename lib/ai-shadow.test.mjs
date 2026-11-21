import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiShadowAgents, buildAiShadowReview, normalizeAiShadowEvidence,
  summarizeAiShadowReviews, validateAiShadowDecision,
} from './ai-shadow.ts';

const evaluatedAt = '2026-11-22T12:00:10.000Z';
const closedAt = '2026-11-22T11:59:59.999Z';
const identity = { agent: 'MARKET_STRUCTURE', provider: 'GEMINI', model: 'gemini-fixture', promptVersion: 'structure-1' };
const candidate = {
  candidateSignalId: 'fixture-signal-17', strategy: 'STANDARD', symbol: 'BTCUSDT', side: 'LONG', evaluatedAt,
  observations: [
    { metric: 'SUPERTREND_DIRECTION', source: 'CLOSED_FUTURES_CANDLE', observedAt: closedAt, value: 1 },
    { metric: 'CANDLE_CLOSE', source: 'CLOSED_FUTURES_CANDLE', observedAt: closedAt, value: 63231 },
    { metric: 'EMA_STACK', source: 'CLOSED_FUTURES_CANDLE', observedAt: closedAt, value: 1 },
    { metric: 'BOOK_SPREAD_BPS', source: 'FUTURES_ORDER_BOOK', observedAt: '2026-11-22T11:59:59.000Z', value: 5 },
  ],
};
const response = {
  ...identity, candidateSignalId: candidate.candidateSignalId, strategy: candidate.strategy, marketRegime: 'TRENDING_UP',
  evidenceAsOf: evaluatedAt, supportingFactors: [{ metric: 'EMA_STACK', observedAt: closedAt, explanation: 'Directional EMA stack.' }],
  conflictingFactors: [], missingEvidence: [], decision: 'APPROVE', explanation: 'The closed candle supports the directional regime.',
};

test('normalizes only timestamped, numeric market evidence and expires stale measurements', () => {
  const normalized = normalizeAiShadowEvidence(candidate);
  assert.deepEqual(normalized.observations.map((entry) => entry.metric), ['CANDLE_CLOSE', 'EMA_STACK', 'SUPERTREND_DIRECTION']);
  const liquidity = buildAiShadowReview(normalized, { ...identity, agent: 'LIQUIDITY_SWEEP' });
  assert.equal(liquidity.mode, 'SHADOW');
  assert.deepEqual(liquidity.missingEvidence, ['BOOK_SPREAD_BPS', 'BID_DEPTH_QUOTE', 'ASK_DEPTH_QUOTE', 'TAKER_IMBALANCE']);
});

test('rejects credentials, untrusted source prose, duplicate, future and out-of-range evidence', () => {
  const { observations } = candidate;
  const base = { ...candidate, observations: [observations[0]] };
  for (const invalid of [
    { ...base, exchangeCredentials: 'mock-do-not-forward' },
    { ...base, observations: [{ ...observations[0], text: 'untrusted provider content' }] },
    { ...base, observations: [{ ...observations[0], source: 'APPROVED_NEWS' }] },
    { ...base, observations: [observations[0], observations[0]] },
    { ...base, observations: [{ ...observations[0], observedAt: '2026-11-22T12:00:11.000Z' }] },
    { ...base, observations: [{ ...observations[0], value: 99 }] },
  ]) assert.throws(() => normalizeAiShadowEvidence(invalid));
});

test('decisions require exact candidate, configured model, prompt version and original source timestamps', () => {
  const evidence = normalizeAiShadowEvidence(candidate);
  assert.deepEqual(validateAiShadowDecision(response, evidence, identity), response);
  for (const invalid of [
    { ...response, strategy: 'HIGH_RISK' },
    { ...response, candidateSignalId: 'other-signal' },
    { ...response, agent: 'RISK_GUARDIAN' },
    { ...response, provider: 'OPENAI' },
    { ...response, model: 'other-model' },
    { ...response, promptVersion: 'structure-2' },
    { ...response, evidenceAsOf: closedAt },
    { ...response, extraOrder: { size: 50 } },
    { ...response, supportingFactors: [{ ...response.supportingFactors[0], observedAt: evaluatedAt }] },
    { ...response, supportingFactors: [{ ...response.supportingFactors[0], metric: 'BOOK_SPREAD_BPS' }] },
    { ...response, conflictingFactors: response.supportingFactors },
  ]) assert.throws(() => validateAiShadowDecision(invalid, evidence, identity));
});

test('does not accept an approval that omits missing required evidence or has no support', () => {
  const incomplete = normalizeAiShadowEvidence({ ...candidate, observations: candidate.observations.slice(1) });
  assert.throws(() => validateAiShadowDecision(response, incomplete, identity));
  const disclosed = { ...response, missingEvidence: ['SUPERTREND_DIRECTION'] };
  assert.throws(() => validateAiShadowDecision(disclosed, incomplete, identity));
  assert.equal(validateAiShadowDecision({ ...disclosed, decision: 'NEEDS_REVIEW' }, incomplete, identity).decision, 'NEEDS_REVIEW');
  assert.throws(() => validateAiShadowDecision({ ...response, supportingFactors: [] }, normalizeAiShadowEvidence(candidate), identity));
});

test('returns only shadow results and refuses duplicate agents without activating execution', () => {
  const evidence = normalizeAiShadowEvidence(candidate);
  assert.equal(aiShadowAgents.length, 6);
  const summary = summarizeAiShadowReviews(evidence, [{ identity, response }]);
  assert.equal(summary.mode, 'SHADOW');
  assert.equal(summary.executionEligible, false);
  assert.equal(summary.missingAgents.length, 5);
  assert.equal(summary.decisions[0].decision, 'APPROVE');
  assert.throws(() => summarizeAiShadowReviews(evidence, [{ identity, response }, { identity, response }]));
});
