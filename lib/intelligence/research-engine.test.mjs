import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchEngine, MemoryResearchJournal, analyzeOnChainContext, createOnChainResearchProvider, orderBookGapBps } from './research-engine.ts';

const now = 1_000_000;
const bars = Array.from({ length: 25 }, (_, index) => ({ openTime: now - (26 - index) * 1000,
  closeTime: now - (25 - index) * 1000, availableAt: now - (25 - index) * 1000,
  open: 80 + index - 0.1, high: 80 + index + 0.3, low: 80 + index - 0.3, close: 80 + index, volume: 1000 }));
function observation(at, overrides = {}) {
  return { symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: at, receivedAt: at, price: 110,
    bid: 109.99, ask: 110.01, quoteVolume: 10_000, buyQuoteVolume: 9_000, sellQuoteVolume: 1_000,
    bidDepth: 100_000, askDepth: 30_000, fresh: true, sequenceValid: true, feedEpoch: 0, ...overrides };
}
function warm(engine) { for (let index = 4; index > 0; index--) engine.ingest(observation(now - index * 1000), now - index * 1000, { bars }); }

test('research ranks a fully evidenced breakout separately for Standard and High-Risk', () => {
  const journal = new MemoryResearchJournal(); const engine = new ResearchEngine(journal); warm(engine);
  const decisions = engine.ingest(observation(now, { quoteVolume: 50_000, buyQuoteVolume: 45_000, sellQuoteVolume: 5_000 }), now, { bars });
  assert.deepEqual(decisions.map(d => d.strategy), ['STANDARD', 'HIGH_RISK']);
  assert.ok(decisions.every(d => d.classification === 'READY_FOR_RESEARCH'));
  assert.ok(decisions.every(d => d.evidence.relativeVolume === 5 && d.evidence.marketRegime === 'BULLISH'));
  assert.ok(decisions.every(d => d.evidence.exchangeFlowAttribution.includes('NOT_VERIFIED_WHALE')));
  assert.equal(journal.read().length, 10);
  assert.ok(journal.read().every(d => d.reasons.length && Object.keys(d.evidence).length > 10));
  assert.equal(MemoryResearchJournal.restore(journal.serialize()).read().length, 10);
});
test('stale/future/gapped/invalid required market inputs override a high momentum score', () => {
  for (const overrides of [{ fresh: false }, { sequenceValid: false }, { eventTime: now + 1 },
    { receivedAt: now + 1 }, { eventTime: now - 6000 }, { price: NaN }, { buyQuoteVolume: 20_000 }]) {
    const engine = new ResearchEngine(); warm(engine);
    const decisions = engine.ingest(observation(now, overrides), now, { bars });
    assert.ok(decisions.every(d => d.classification === 'REJECTED' && d.score === 0 && d.side === 'WAIT'));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(decisions)));
  }
});
test('spread, liquidity, closed-bar availability and unknown data cannot fabricate readiness', () => {
  for (const overrides of [{ ask: 115 }, { askDepth: 1 }, { quoteVolume: 1, buyQuoteVolume: 0.9, sellQuoteVolume: 0.1 }]) {
    const engine = new ResearchEngine(); warm(engine);
    assert.ok(engine.ingest(observation(now, overrides), now, { bars }).every(d => d.classification === 'REJECTED'));
  }
  const engine = new ResearchEngine(); warm(engine);
  const futureBars = bars.map(bar => ({ ...bar, availableAt: now + 1 }));
  const decisions = engine.ingest(observation(now, { quoteVolume: 50_000, buyQuoteVolume: 45_000, sellQuoteVolume: 5_000 }), now, { bars: futureBars });
  assert.ok(decisions.every(d => d.classification === 'WATCH' && d.reasons.includes('INSUFFICIENT_OR_STALE_CLOSED_CONTEXT')));
});
test('duplicate suppression and cooldown persist across research restart without poisoning history', () => {
  const engine = new ResearchEngine(); warm(engine);
  const signal = observation(now, { quoteVolume: 50_000, buyQuoteVolume: 45_000, sellQuoteVolume: 5_000 });
  engine.ingest(signal, now, { bars });
  assert.ok(engine.ingest(signal, now, { bars }).every(d => d.reasons.includes('DUPLICATE_OR_OUT_OF_ORDER_EVENT')));
  const restarted = new ResearchEngine(); restarted.restore(engine.snapshot());
  const decisions = restarted.ingest(observation(now + 1000, { quoteVolume: 100_000, buyQuoteVolume: 90_000, sellQuoteVolume: 10_000 }), now + 1000, { bars });
  assert.ok(decisions.every(d => d.classification === 'WATCH' && d.reasons.includes('SYMBOL_COOLDOWN')));
  assert.throws(() => restarted.restore('{"version":2}'), /Invalid research/);
});
test('feed epoch changes discard previous baselines and require new closed context', () => {
  const engine = new ResearchEngine(); warm(engine);
  const result = engine.ingest(observation(now, { feedEpoch: 1, quoteVolume: 50_000, buyQuoteVolume: 45_000, sellQuoteVolume: 5_000 }), now, { bars });
  assert.ok(result.every(d => d.classification === 'WATCH' && d.evidence.warmupSamples === 0 && d.evidence.closedBars === 0));
  const restarted = new ResearchEngine(); restarted.restore(engine.snapshot());
  assert.ok(restarted.ingest(observation(now + 1, { feedEpoch: 1 }), now + 1, { bars }).every(d => d.evidence.closedBars === 0));
});
test('on-chain attribution is optional, freshness bounded and never links exchange trader identity', () => {
  assert.equal(analyzeOnChainContext(null, now).available, false);
  const source = { provider: 'test-provider', observedAt: now, attribution: 'PROVIDER_ATTRIBUTED', confidence: 0.7, netflow: 10 };
  assert.equal(analyzeOnChainContext(source, now).exchangeTraderIdentityLinked, false);
  assert.equal(analyzeOnChainContext({ ...source, observedAt: now + 1 }, now).available, false);
  assert.equal(analyzeOnChainContext({ ...source, confidence: 2 }, now).available, false);
  assert.equal(analyzeOnChainContext(source, now + 60_001).available, false);
});
test('official Unicode symbols retain normalized identifiers without dropping required market-data gates', () => {
  const engine = new ResearchEngine();
  const decisions = engine.ingest(observation(now, { symbol: '币USDT' }), now, { bars });
  assert.ok(decisions.every(d => d.symbol === '币USDT' && d.classification === 'WATCH'));
  assert.ok(new ResearchEngine().ingest(observation(now, { symbol: 'btcusdt' }), now, { bars }).every(d => d.classification === 'REJECTED'));
});
test('optional on-chain transport validates freshness and persists attribution evidence without inventing identity', async () => {
  const provider = createOnChainResearchProvider('fixture', async () => ({ observedAt: now,
    attribution: 'PROVIDER_ATTRIBUTED', confidence: 0.6, netflow: 12 }));
  const onChain = await provider.context('BTCUSDT', now);
  const journal = new MemoryResearchJournal();
  new ResearchEngine(journal).ingest(observation(now), now, { bars, onChain });
  assert.equal(journal.read()[0].evidence.onChainConfidence, 0.6);
  assert.equal(journal.read()[0].evidence.onChainAttribution, 'PROVIDER_ATTRIBUTED');
  assert.equal(await provider.context('BTCUSDT', now + 60_001), null);
  assert.equal(await createOnChainResearchProvider('fixture', async () => { throw new Error('unavailable'); }).context('BTCUSDT', now), null);
});
test('real depth-level gaps are measured only from fresh sequenced caller context, never invented from aggregate depth', () => {
  const book = { observedAt: now, bids: [[109.99, 1], [109.98, 1], [100, 1]], asks: [[110.01, 1], [110.02, 1]] };
  assert.ok(orderBookGapBps(book, now) > 100);
  assert.equal(orderBookGapBps(undefined, now), null);
  assert.equal(orderBookGapBps({ ...book, observedAt: now - 6000 }, now), null);
  const engine = new ResearchEngine(); warm(engine);
  assert.ok(engine.ingest(observation(now, { quoteVolume: 50_000, buyQuoteVolume: 45_000, sellQuoteVolume: 5_000 }), now,
    { bars, orderBook: book }).every(d => d.reasons.includes('ORDER_BOOK_GAP')));
});
test('equal flow rate over a longer publication interval is not a volume spike and old volume windows cannot become ready', () => {
  const engine = new ResearchEngine();
  for (let index = 4; index > 0; index--) {
    engine.ingest(observation(now - index * 1000, { volumeIntervalMs: 1000 }), now - index * 1000, { bars });
  }
  const decisions = engine.ingest(observation(now + 3000, { volumeIntervalMs: 4000,
    quoteVolume: 40_000, buyQuoteVolume: 36_000, sellQuoteVolume: 4000 }), now + 3000, { bars });
  assert.ok(decisions.every(d => d.classification === 'WATCH' && d.evidence.relativeVolume === 1 && d.evidence.volumeAcceleration === 0));
  assert.ok(engine.ingest(observation(now + 4000, { volumeIntervalMs: 6000 }), now + 4000, { bars }).every(d =>
    d.classification === 'REJECTED' && d.reasons.includes('VOLUME_WINDOW_TOO_OLD')));
});

test('unknown customer or credential fields never enter shared research snapshots or evidence journals', () => {
  const journal = new MemoryResearchJournal(); const engine = new ResearchEngine(journal); warm(engine);
  const before = JSON.parse(engine.snapshot());
  for (const extra of [{ apiKey: 'private-fixture-sentinel' }, { tenantId: 42 }, { customerCredential: 'private-fixture-sentinel' }]) {
    const decisions = engine.ingest(observation(now, { ...extra, feedEpoch: 99 }), now, { bars });
    assert.ok(decisions.every(d => d.classification === 'REJECTED' && d.side === 'WAIT'));
  }
  const after = JSON.parse(engine.snapshot());
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.epochs, before.epochs);
  assert.deepEqual(after.contextSince, before.contextSince);
  assert.doesNotMatch(engine.snapshot() + journal.serialize(), /private-fixture-sentinel|apiKey|customerCredential|tenantId/);
  const poisoned = { ...before, history: { BTCUSDT: [observation(now, { apiKey: 'private-fixture-sentinel' })] } };
  assert.throws(() => new ResearchEngine().restore(JSON.stringify(poisoned)), /Invalid research history/);
});

test('rejected old volume windows cannot poison the next relative-volume baseline or cumulative flow', () => {
  const engine = new ResearchEngine(); warm(engine);
  const before = JSON.parse(engine.snapshot()).history;
  const rejected = engine.ingest(observation(now, { volumeIntervalMs: 6000, quoteVolume: 9_000_000,
    buyQuoteVolume: 9_000_000, sellQuoteVolume: 0 }), now, { bars });
  assert.ok(rejected.every(d => d.classification === 'REJECTED' && d.reasons.includes('VOLUME_WINDOW_TOO_OLD')));
  assert.deepEqual(JSON.parse(engine.snapshot()).history, before);
  const next = engine.ingest(observation(now + 1000, { volumeIntervalMs: 1000, quoteVolume: 50_000,
    buyQuoteVolume: 45_000, sellQuoteVolume: 5000 }), now + 1000, { bars });
  assert.ok(next.every(d => d.evidence.relativeVolume === 5));
});

test('minimum liquidity and thin-depth checks use explicit notional-per-second units independent of publication cadence', () => {
  const outputs = [];
  for (const interval of [50, 1000]) {
    const engine = new ResearchEngine(); warm(engine);
    const notional = 50_000 * interval / 1000;
    outputs.push(engine.ingest(observation(now, { volumeIntervalMs: interval, quoteVolume: notional,
      buyQuoteVolume: notional * 0.9, sellQuoteVolume: notional * 0.1 }), now, { bars }));
  }
  assert.ok(outputs.flat().every(d => d.classification === 'READY_FOR_RESEARCH'));
  assert.deepEqual(outputs[0].map(d => d.reasons), outputs[1].map(d => d.reasons));
  assert.ok(outputs.flat().every(d => d.evidence.volumeNotionalPerSecond === 50_000 && d.evidence.thinDepthProxy === false));
});
