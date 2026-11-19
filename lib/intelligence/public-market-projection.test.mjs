import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicMarketProjection } from './public-market-projection.ts';
import { BinanceMarketFeed } from './market-feed.ts';

const at = 1_800_000_000_000;
const observation = (changes = {}) => ({ symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: at, receivedAt: at,
  price: 100, bid: 99, ask: 101, quoteVolume: 400, buyQuoteVolume: 200, sellQuoteVolume: 200,
  bidDepth: 1000, askDepth: 1100, fresh: true, sequenceValid: true, feedEpoch: 0, ...changes });
const projection = () => new PublicMarketProjection(['BTCUSDT', 'ETHUSDT'], ['BTCUSDT']);

test('actual local feed observation carries all required-input evidence without claiming research readiness', () => {
  const feed = new BinanceMarketFeed(['BTCUSDT', 'ETHUSDT']);
  feed.ingest({ e: '24hrTicker', E: at, s: 'BTCUSDT', c: '100', q: '90000000' }, at);
  for (const a of [1, 2]) feed.ingest({ e: 'aggTrade', E: at, s: 'BTCUSDT', a, p: '100', q: '2', m: false }, at);
  feed.ingest({ e: 'depthUpdate', E: at, s: 'BTCUSDT', U: 9, u: 11, pu: 8, b: [['99', '2']], a: [['101', '3']] }, at);
  assert.equal(feed.installSnapshot('BTCUSDT', { lastUpdateId: 10, bids: [['99', '1']], asks: [['101', '1']] }, at), true);
  const state = projection();
  assert.equal(state.ingest(feed.takeObservation('BTCUSDT', at), at), 'APPLIED');
  const view = state.view(at + 100);
  assert.equal(view.market.enabledSymbols, 2); assert.equal(view.selectedCoverage.fresh, 1);
  assert.equal(view.rows[0].state, 'FRESH_OBSERVATION'); assert.equal(view.rows[0].freshnessVerified, true);
  assert.equal(view.rows[0].requiredInputFreshness, 'VERIFIED_ALL_REQUIRED_INPUTS');
  assert.equal(view.rows[0].price, 100); assert.equal(view.tickerCoverage.state, 'NOT_PROJECTED');
  assert.equal(view.market.continuousFeedVerified, false); assert.deepEqual(view.candidates, []); assert.equal(view.executionEnabled, false);
});

test('duplicate identity is deterministic, conflicts fail closed and callers cannot mutate stored samples', () => {
  const state = projection(), raw = observation();
  state.ingest(raw, at); raw.price = 500;
  assert.equal(state.view(at).rows[0].price, 100);
  assert.equal(state.ingest(Object.fromEntries(Object.entries(observation()).reverse()), at), 'DUPLICATE');
  assert.throws(() => state.ingest(observation({ price: 105 }), at), /Conflicting/);
  assert.equal(state.batchPlan(0).nextRevision, 1);
});

test('new epochs replace old epochs but old replay cannot rewind newer per-symbol state', () => {
  const state = projection(); state.ingest(observation(), at);
  state.ingest(observation({ feedEpoch: 2, eventTime: at + 20, receivedAt: at + 20, price: 102 }), at + 20);
  assert.equal(state.ingest(observation({ feedEpoch: 1, eventTime: at + 30, receivedAt: at + 30 }), at + 30), 'SUPERSEDED');
  assert.equal(state.ingest(observation({ feedEpoch: 2, eventTime: at + 10, receivedAt: at + 10 }), at + 30), 'SUPERSEDED');
  assert.equal(state.view(at + 30).rows[0].price, 102);
});

test('invalid, unknown, future, stale and credential-bearing inputs cannot poison a valid projection', () => {
  const state = projection(); state.ingest(observation(), at);
  for (const change of [{ apiKey: 'fixture-only' }, { symbol: 'ETHUSDT' }, { feedEpoch: -1 }, { feedEpoch: undefined },
    { eventTime: at + 1 }, { receivedAt: at + 1 }, { sequenceValid: false }, { fresh: false }, { bid: 102 },
    { quoteVolume: NaN }, { quoteVolume: 500 }, { price: Infinity }, { volumeIntervalMs: 6000 }]) {
    assert.throws(() => state.ingest(observation(change), at));
  }
  assert.throws(() => state.ingest(observation(), at + 5001), /stale/);
  assert.equal(state.view(at).rows[0].price, 100);
});

test('restart checkpoints retain original freshness and reject corruption or substituted coverage', () => {
  const state = projection(); state.ingest(observation(), at);
  const resumed = PublicMarketProjection.restore(state.checkpoint(), at + 6000);
  assert.equal(resumed.view(at + 6000).rows[0].state, 'STALE');
  assert.equal(resumed.view(at + 6000).rows[0].price, null);
  assert.equal(resumed.batchPlan(0).batchId, state.batchPlan(0).batchId);
  for (const mutate of [value => { value.version = 2; }, value => { value.revision = 0; },
    value => { value.observations.push(value.observations[0]); }, value => { value.observations[0].symbol = 'ETHUSDT'; },
    value => { value.observations[0].receivedAt = at + 7000; }, value => { value.credentials = {}; }]) {
    const checkpoint = JSON.parse(state.checkpoint()); mutate(checkpoint);
    assert.throws(() => PublicMarketProjection.restore(JSON.stringify(checkpoint), at + 6000));
  }
});

test('bounded coverage and pure dry-run batches cannot authorize persistence or execution', () => {
  assert.throws(() => new PublicMarketProjection(['BTCUSDT'], ['ETHUSDT']));
  assert.throws(() => new PublicMarketProjection(['BTCUSDT', 'BTCUSDT'], ['BTCUSDT']));
  assert.throws(() => new PublicMarketProjection(Array.from({ length: 201 }, (_, index) => `T${index}USDT`), Array.from({ length: 201 }, (_, index) => `T${index}USDT`)));
  const state = projection(); state.ingest(observation(), at);
  const plan = state.batchPlan(0);
  assert.equal(plan.mode, 'DRY_RUN_ONLY'); assert.equal(plan.remoteWriteAuthorized, false);
  assert.equal(plan.expectedRevision, 0); assert.equal(plan.nextRevision, 1); assert.match(plan.batchId, /^[a-f0-9]{64}$/);
  assert.throws(() => state.batchPlan(2));
});
