import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
function compile(name) {
  const filename = path.join(directory, name + '.ts');
  const sourceModule = new Module(filename); sourceModule.filename = filename;
  sourceModule.paths = Module._nodeModulePaths(directory);
  sourceModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return sourceModule.exports;
}
const original = Module._load;
let replayResearch, walkForwardEvaluation;
try {
  Module._load = function(name, parent, main) { return name === './research-engine' ? compile('research-engine') : original(name, parent, main); };
  ({ replayResearch, walkForwardEvaluation } = compile('research-replay'));
} finally { Module._load = original; }

const now = 1_000_000;
function observation(at, large = false) {
  return { symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: at, receivedAt: at, price: 110,
    bid: 109.99, ask: 110.01, quoteVolume: large ? 50_000 : 10_000, buyQuoteVolume: large ? 45_000 : 9_000,
    sellQuoteVolume: large ? 5_000 : 1_000, bidDepth: 100_000, askDepth: 30_000, fresh: true, sequenceValid: true, feedEpoch: 0 };
}
function fixture() {
  const bars = Array.from({ length: 25 }, (_, index) => {
    const closeTime = now - (25 - index) * 1000;
    return { type: 'BAR', at: closeTime, symbol: 'BTCUSDT', bar: { openTime: closeTime - 1000, closeTime,
      availableAt: closeTime, open: 80 + index - 0.1, high: 80 + index + 0.3, low: 80 + index - 0.3, close: 80 + index, volume: 1000 } };
  });
  const warmup = Array.from({ length: 4 }, (_, index) => ({ type: 'OBSERVATION', at: now - (4 - index) * 1000, observation: observation(now - (4 - index) * 1000) }));
  return [...bars, ...warmup, { type: 'OBSERVATION', at: now, observation: observation(now, true) },
    { type: 'TRADE', at: now + 50, symbol: 'BTCUSDT', price: 110, quantity: 1 },
    { type: 'TRADE', at: now + 100, symbol: 'BTCUSDT', price: 110, quantity: 1 },
    { type: 'TRADE', at: now + 150, symbol: 'BTCUSDT', price: 110, quantity: 1 },
    { type: 'FUNDING', at: now + 160, symbol: 'BTCUSDT', markPrice: 110, rate: 0.001 },
    { type: 'TRADE', at: now + 200, symbol: 'BTCUSDT', price: 100, quantity: 1 },
    { type: 'TRADE', at: now + 300, symbol: 'BTCUSDT', price: 100, quantity: 1 },
    { type: 'TRADE', at: now + 350, symbol: 'BTCUSDT', price: 115, quantity: 1 }].sort((a, b) => a.at - b.at);
}

test('replay models latency, partial fills, latched stop exits and explicit friction separately per strategy', () => {
  const result = replayResearch(fixture());
  assert.equal(result.simulation, true); assert.equal(result.realExchangePerformance, false);
  for (const strategy of ['STANDARD', 'HIGH_RISK']) {
    const report = result.reports[strategy];
    assert.equal(report.completedTrades, 1); assert.equal(report.openPositions, 0);
    assert.deepEqual(report.fills.map(f => f.reason), ['ENTRY', 'ENTRY', 'STOP', 'STOP']);
    assert.equal(report.fills[0].at, now + 100);
    assert.equal(report.fills[2].at, now + 300);
    assert.ok(report.fills.every(f => f.quantity <= 0.1));
    assert.ok(report.fees > 0 && report.fundingCost > 0 && report.maxDrawdownFraction > 0);
    assert.ok(report.netExpectancy < 0);
    assert.ok(report.finalEquity < 10_000);
  }
});
test('fees, spread and adverse slippage reduce marked equity rather than manufacturing favorable fills', () => {
  const paid = replayResearch(fixture());
  const free = replayResearch(fixture(), { feeBps: 0, slippageBps: 0, spreadBps: 0 });
  assert.ok(paid.reports.STANDARD.finalEquity < free.reports.STANDARD.finalEquity);
  assert.equal(free.reports.STANDARD.fees, 0);
});
test('short replay uses sell entries, buy stop exits and the correct funding sign', () => {
  const events = fixture().map(event => {
    if (event.type === 'BAR') {
      const price = 200 - event.bar.close;
      return { ...event, bar: { ...event.bar, open: price + 0.1, high: price + 0.3, low: price - 0.3, close: price } };
    }
    if (event.type === 'OBSERVATION') {
      const value = event.observation;
      return { ...event, observation: { ...value, price: 90, bid: 89.99, ask: 90.01,
        buyQuoteVolume: value.sellQuoteVolume, sellQuoteVolume: value.buyQuoteVolume,
        bidDepth: value.askDepth, askDepth: value.bidDepth } };
    }
    if (event.type === 'TRADE') return { ...event, price: 200 - event.price };
    return { ...event, markPrice: 90 };
  });
  const report = replayResearch(events).reports.STANDARD;
  assert.equal(report.completedTrades, 1);
  assert.equal(report.fills[0].direction, 'SELL');
  assert.equal(report.fills[2].direction, 'BUY');
  assert.ok(report.fundingCost < 0);
});
test('ordered availability prevents future closed bars and chronological reordering', () => {
  assert.throws(() => replayResearch([{ type: 'BAR', at: now, symbol: 'BTCUSDT', bar: { closeTime: now + 1, availableAt: now + 1 } }]), /Look-ahead/);
  assert.throws(() => replayResearch([{ type: 'TRADE', at: 2, symbol: 'BTCUSDT', price: 100, quantity: 1 },
    { type: 'TRADE', at: 1, symbol: 'BTCUSDT', price: 100, quantity: 1 }]), /ordered/);
  assert.throws(() => replayResearch([], { participation: 2 }), /Invalid replay/);
});
test('walk-forward uses historical warmup only and reports untouched out-of-sample windows', () => {
  const events = fixture();
  const result = walkForwardEvaluation(events, { trainingEvents: 29, testEvents: 8 });
  assert.equal(result.windows.length, 1);
  assert.ok(result.windows[0].trainingEnd <= result.windows[0].testStart);
  assert.equal(result.windows[0].outOfSample.STANDARD.completedTrades, 1);
  assert.throws(() => replayResearch(events.slice(0, 1), { warmupEvents: events.slice(-1) }), /Warmup/);
});
test('empty/unfinished replay reports missing denominators and open state without fictitious realized trades', () => {
  const empty = replayResearch([]).reports.STANDARD;
  assert.equal(empty.profitFactor, null); assert.equal(empty.netExpectancy, null);
  assert.equal(empty.completedTrades, 0); assert.equal(empty.finalEquity, 10_000);
  const partial = replayResearch(fixture().slice(0, 32)).reports.STANDARD;
  assert.equal(partial.completedTrades, 0); assert.equal(partial.openPositions, 1);
});
test('fresh observation marks open equity without requiring another trade; invalid quote cannot revalue it', () => {
  const partialEvents = fixture().slice(0, 32);
  const base = replayResearch(partialEvents).reports.STANDARD;
  const mark = { type: 'OBSERVATION', at: now + 200, observation: { ...observation(now + 200), price: 120, bid: 119.99, ask: 120.01 } };
  const marked = replayResearch([...partialEvents, mark]).reports.STANDARD;
  assert.ok(marked.finalEquity > base.finalEquity);
  const bad = { ...mark, observation: { ...mark.observation, fresh: false } };
  assert.equal(replayResearch([...partialEvents, bad]).reports.STANDARD.finalEquity, base.finalEquity);
});
