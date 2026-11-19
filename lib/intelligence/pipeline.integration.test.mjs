import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { BinanceMarketFeed } from './market-feed.ts';
import { ResearchEngine } from './research-engine.ts';

const require = createRequire(import.meta.url);
function compile(name, stubs = {}) {
  const filename = fileURLToPath(new URL(name, import.meta.url));
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = key => key in stubs ? stubs[key] : require(key);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const risk = compile('./risk-governor.ts');
const { TenantPaperService, MemoryPaperJournal, defaultPaperConfiguration } = compile('./tenant-paper.ts', { './risk-governor': risk });

// Synthetic replay fixture ONLY. Never connected to a production feed or UI.
function pipeline() {
  const now = 1_000_000; const feed = new BinanceMarketFeed(['BTCUSDT']); const research = new ResearchEngine();
  const bars = Array.from({ length: 25 }, (_, index) => ({ openTime: now - (26-index)*1000,
    closeTime: now-(25-index)*1000, availableAt: now-(25-index)*1000,
    open: 80+index-0.1, high: 80+index+0.3, low: 80+index-0.3, close: 80+index, volume: 1000 }));
  let tradeId = 0, market, decisions;
  for (let index = 0; index < 5; index++) {
    const at = now - 4000 + index * 1000;
    feed.ingest({ e: '24hrTicker', E: at, s: 'BTCUSDT', c: '110', q: '90000000', st: 1 }, at);
    const trade = (quantity, maker = false) => feed.ingest({ e: 'aggTrade', E: at, s: 'BTCUSDT', a: ++tradeId, p: '110', q: String(quantity), m: maker, st: 1 }, at);
    if (!index) { trade(90); trade(10, true); } else trade(index === 4 ? 500 : 100);
    feed.ingest({ e: 'depthUpdate', E: at, s: 'BTCUSDT', U: index ? 11+index : 9,
      u: 11+index, pu: index ? 10+index : 8, b: [['109.99','1000']], a: [['110.01','300']], st: 1 }, at);
    if (!index) assert.equal(feed.installSnapshot('BTCUSDT', { lastUpdateId: 10, bids: [['109.99','1000']], asks: [['110.01','300']] }, at), true);
    market = feed.takeObservation('BTCUSDT', at); assert.ok(market);
    decisions = research.ingest(market, at, { bars });
  }
  return { now, market, decisions, feed };
}
test('replayed feed flows through research, deterministic risk and tenant-scoped paper reservations without exchange calls', async () => {
  const { now, market, decisions } = pipeline();
  const signal = decisions.find(x => x.strategy === 'STANDARD');
  assert.equal(signal.classification, 'READY_FOR_RESEARCH');
  const journal = new MemoryPaperJournal(); const service = new TenantPaperService(journal);
  const actor = { userId: 3, tenantId: 3 };
  await service.configure(actor, { ...defaultPaperConfiguration(), mode: 'PAPER_AUTOPILOT' }, now);
  const intent = { idempotencyKey: 'pipeline-one', symbol: 'BTCUSDT', side: 'LONG', quantity: 1,
    entryPrice: 110, stopPrice: 105, leverage: 2, estimatedLiquidationPrice: 55, correlationGroup: 'CRYPTO' };
  const order = await service.submit(actor, intent, market, signal, now);
  assert.equal(order.status, 'RESERVED');
  assert.equal((await new TenantPaperService(journal).submit(actor, intent, market, signal, now)).key, order.key);
  assert.equal((await service.inspect(actor)).orders.length, 1);
  await service.configure({ userId: 4, tenantId: 4 }, defaultPaperConfiguration(), now);
  assert.equal((await service.inspect({ userId: 4, tenantId: 4 })).orders.length, 0);
  const rejected = await service.submit(actor, { ...intent, idempotencyKey: 'aged-one' }, market, { ...signal, score: 100 }, now+6000);
  assert.equal(rejected.status, 'REJECTED');
  assert.ok(rejected.risk.reasons.some(x => /STALE|MARKET/.test(x)));
});
