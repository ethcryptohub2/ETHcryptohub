import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function compile(name, dependencies = {}) {
  const url = new URL(name, import.meta.url), filename = fileURLToPath(url);
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = request => dependencies[request] ?? require(request);
  mod._compile(ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}
const risk = compile('./risk-governor.ts');
const { TenantPaperService, MemoryPaperJournal, defaultPaperConfiguration, verifyPaperDatabaseIsolation } = compile('./tenant-paper.ts', { './risk-governor': risk });
const { AtomicFilePaperJournal } = compile('./paper-journal.ts');
const now = 1_800_000_000_000, actor = { userId: 1, tenantId: 1 };
function inputs(key = 'paper-one') {
  return {
    intent: { idempotencyKey: key, symbol: 'BTCUSDT', side: 'LONG', quantity: 10, entryPrice: 100,
      stopPrice: 95, leverage: 2, estimatedLiquidationPrice: 50, correlationGroup: 'MAJORS' },
    market: { symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: now, receivedAt: now,
      price: 100, bid: 99.9, ask: 100, quoteVolume: 1_000_000, buyQuoteVolume: 600_000,
      sellQuoteVolume: 400_000, bidDepth: 100_000, askDepth: 90_000, fresh: true, sequenceValid: true },
    signal: { id: 'research-one', symbol: 'BTCUSDT', strategy: 'STANDARD', classification: 'READY_FOR_RESEARCH',
      side: 'LONG', score: 100, observedAt: now, expiresAt: now + 60_000, reasons: [], evidence: {} },
  };
}
async function setup(mode = 'PAPER_AUTOPILOT', journal = new MemoryPaperJournal()) {
  const service = new TenantPaperService(journal);
  await service.configure(actor, { ...defaultPaperConfiguration(), mode }, now);
  return service;
}
const submit = (service, f = inputs(), at = now, confirmation) => service.submit(actor, f.intent, f.market, f.signal, at, confirmation);
test('tenant ownership applies to every configuration/read boundary and snapshots cannot mutate state', async () => {
  const service = await setup();
  await assert.rejects(service.inspect({ userId: 2, tenantId: 1 }), /ownership/);
  await assert.rejects(service.configure({ userId: 2, tenantId: 1 }, defaultPaperConfiguration(), now), /ownership/);
  await service.configure({ userId: 2, tenantId: 2 }, defaultPaperConfiguration(), now);
  await submit(service);
  assert.equal((await service.inspect({ userId: 2, tenantId: 2 })).orders.length, 0);
  const view = await service.inspect(actor); view.killSwitch = true; view.orders.length = 0;
  assert.equal((await service.inspect(actor)).orders.length, 1);
  assert.equal((await service.inspect(actor)).killSwitch, false);
});
test('OBSERVE never reserves and Live Autopilot / credential-bearing fields are rejected', async () => {
  const service = await setup('OBSERVE');
  assert.equal((await submit(service)).status, 'OBSERVED');
  await assert.rejects(service.configure(actor, { ...defaultPaperConfiguration(), mode: 'LIVE_AUTOPILOT' }, now), /paper-only/);
  await assert.rejects(service.configure(actor, { ...defaultPaperConfiguration(), apiKey: 'do-not-store' }, now), /paper-only/);
  const f = inputs('unexpected'); f.intent.apiSecret = 'do-not-store';
  await assert.rejects(submit(service, f), /credentials/);
});
test('CONFIRM requires explicit scoped confirmation and rechecks fresh risk before reserving', async () => {
  const service = await setup('CONFIRM'), f = inputs();
  assert.equal((await submit(service, f)).status, 'CONFIRMATION_REQUIRED');
  assert.equal((await submit(service, f, now, 'CONFIRM_PAPER:other')).status, 'CONFIRMATION_REQUIRED');
  assert.equal((await submit(service, f, now, 'CONFIRM_PAPER:paper-one')).status, 'RESERVED');
  assert.equal((await service.inspect(actor)).orders.length, 1);
  const late = inputs('late'); await submit(service, late);
  assert.equal((await submit(service, late, now + 60_001, 'CONFIRM_PAPER:late')).status, 'REJECTED');
});
test('parallel duplicate submits create one durable reservation; conflicting intent fails', async () => {
  const service = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => submit(service)));
  assert.ok(results.every(x => x.status === 'RESERVED'));
  assert.equal((await service.inspect(actor)).orders.length, 1);
  const f = inputs(); f.intent.quantity = 5;
  await assert.rejects(submit(service, f), /idempotency/);
});
test('reservations consume position and exposure budgets before any fill', async () => {
  const service = await setup();
  await submit(service, inputs('one')); await submit(service, inputs('two')); await submit(service, inputs('three'));
  const fourth = await submit(service, inputs('four'));
  assert.equal(fourth.status, 'REJECTED');
  assert.ok(fourth.risk.reasons.includes('MAXIMUM_POSITIONS'));
});
test('partial fills, fees, close history and risk evidence persist without exchange calls', async () => {
  const service = await setup(), f = inputs(); await submit(service, f);
  assert.equal((await service.fill(actor, 'paper-one', 'fill-one', 4, f.market, now, 4)).status, 'PARTIAL');
  const filled = await service.fill(actor, 'paper-one', 'fill-two', 6, f.market, now + 1, 4);
  assert.equal(filled.status, 'FILLED'); assert.equal(filled.filledQuantity, 10);
  await assert.rejects(service.fill(actor, 'paper-one', 'fill-overflow', 1, f.market, now + 2), /reservation/);
  const closed = await service.close(actor, 'paper-one', { ...f.market, bid: 110, ask: 110.1 }, now + 3, 4);
  assert.equal(closed.status, 'CLOSED'); assert.ok(closed.realizedPnl < 100 && closed.realizedPnl > 99);
  const state = await service.inspect(actor);
  assert.equal(state.orders[0].status, 'CLOSED');
  assert.ok(state.audit.some(e => e.action === 'PAPER_FILL'));
  assert.ok(state.equity > 10_000);
});
test('stale, malformed and expired-signal fills cannot turn a reservation into a position', async () => {
  const service = await setup(), f = inputs(); await submit(service, f);
  await assert.rejects(service.fill(actor, 'paper-one', 'fill-one', 1, { ...f.market, eventTime: NaN }, now), /rejected|stale/);
  await assert.rejects(service.fill(actor, 'paper-one', 'fill-one', 1, { ...f.market, eventTime: now + 60_001, receivedAt: now + 60_001 }, now + 60_001), /SIGNAL_NOT_ELIGIBLE/);
  assert.equal((await service.inspect(actor)).orders[0].filledQuantity, 0);
});
test('kill switch stops new risk/fills but still permits a fresh reduce-only paper close', async () => {
  const service = await setup(), f = inputs(); await submit(service, f);
  await service.fill(actor, 'paper-one', 'fill-one', 1, f.market, now);
  await service.setSafety(actor, { killSwitch: true, exchangeAvailable: true }, now + 1);
  assert.equal((await submit(service, inputs('blocked'), now + 2)).status, 'REJECTED');
  await assert.rejects(service.fill(actor, 'paper-one', 'fill-blocked', 1, f.market, now + 2), /paused/);
  assert.equal((await service.close(actor, 'paper-one', f.market, now + 2)).status, 'CLOSED');
});
test('loss accounting cannot be hidden by resetting capital and events reject backwards time', async () => {
  const service = await setup(), f = inputs(); await submit(service, f); await service.fill(actor, 'paper-one', 'fill-all', 10, f.market, now);
  await service.close(actor, 'paper-one', { ...f.market, bid: 90, ask: 90.1 }, now + 1);
  const state = await service.inspect(actor); assert.equal(state.consecutiveLosses, 1); assert.ok(state.realizedDailyPnl < 0);
  await assert.rejects(service.configure(actor, { ...defaultPaperConfiguration(), initialEquity: 20_000 }, now + 2), /capital/);
  await assert.rejects(service.setSafety(actor, { killSwitch: true, exchangeAvailable: true }, now), /monotonic/);
});
test('unrealized losses override high scores, and unmarked cross-symbol portfolios fail closed', async () => {
  const service = await setup(), f = inputs(); await submit(service, f); await service.fill(actor, 'paper-one', 'fill-all', 10, f.market, now);
  const lower = inputs('loss-gated');
  lower.market = { ...lower.market, price: 60, bid: 60, ask: 60.1 };
  const rejected = await submit(service, lower, now + 1);
  assert.ok(rejected.risk.reasons.includes('DAILY_LOSS_LIMIT'));
  const other = inputs('unmarked');
  other.intent.symbol = other.market.symbol = other.signal.symbol = 'ETHUSDT';
  const unmarked = await submit(service, other, now + 2);
  assert.ok(unmarked.risk.reasons.includes('PORTFOLIO_MARKS_UNAVAILABLE'));
  assert.equal(unmarked.status, 'REJECTED');
});
test('atomic file journal survives a new service instance, retains kill state and rejects crash locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartexit-paper-'));
  try {
    const service = await setup('PAPER_AUTOPILOT', new AtomicFilePaperJournal(directory));
    await submit(service); await service.setSafety(actor, { killSwitch: true, exchangeAvailable: false }, now + 1);
    const restarted = new TenantPaperService(new AtomicFilePaperJournal(directory));
    const state = await restarted.inspect(actor);
    assert.equal(state.killSwitch, true); assert.equal(state.orders.length, 1);
    assert.equal((await submit(restarted, inputs(), now + 2)).key, 'paper-one');
    const name = createHash('sha256').update('paper-tenant:1').digest('hex');
    const lock = join(directory, `${name}.lock`); await writeFile(lock, 'crashed-owner');
    await assert.rejects(restarted.setSafety(actor, { killSwitch: false, exchangeAvailable: true }, now + 3), /crash-lock/);
    await unlink(lock);
    assert.equal((await restarted.inspect(actor)).killSwitch, true);
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('smartexit-paper-')) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});
test('database isolation verification rejects absent schema, disabled RLS, missing ownership and browser grants', () => {
  assert.equal(verifyPaperDatabaseIsolation([]).verified, false);
  const evidence = ['paper_account_states', 'research_decisions']
    .map(table => ({ table, rowSecurity: true, forcedRowSecurity: true, tenantConstraint: true, browserGrants: [] }));
  assert.equal(verifyPaperDatabaseIsolation(evidence).verified, true);
  for (const change of [{ rowSecurity: false }, { forcedRowSecurity: false }, { forcedRowSecurity: undefined },
    { tenantConstraint: false }, { browserGrants: ['authenticated'] }, { browserGrants: ['PUBLIC'] }, { browserGrants: undefined }]) {
    assert.equal(verifyPaperDatabaseIsolation([{ ...evidence[0], ...change }, ...evidence.slice(1)]).verified, false);
  }
  assert.equal(verifyPaperDatabaseIsolation([...evidence, evidence[0]]).verified, false);
});

test('shared research RLS evidence does not require a fabricated customer ownership constraint', () => {
  const tenant = { table: 'paper_account_states', rowSecurity: true, forcedRowSecurity: true, tenantConstraint: true, browserGrants: [] };
  const shared = { table: 'research_decisions', rowSecurity: true, forcedRowSecurity: true, browserGrants: [] };
  assert.equal(verifyPaperDatabaseIsolation([tenant, shared]).verified, true);
  assert.equal(verifyPaperDatabaseIsolation([{ ...tenant, tenantConstraint: undefined }, shared]).verified, false);
  assert.equal(verifyPaperDatabaseIsolation([tenant, { ...shared, forcedRowSecurity: false }]).verified, false);
});
test('independent file-journal writers cannot create duplicate reservations and corrupt state fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartexit-paper-'));
  try {
    const one = await setup('PAPER_AUTOPILOT', new AtomicFilePaperJournal(directory));
    const two = new TenantPaperService(new AtomicFilePaperJournal(directory));
    const results = await Promise.allSettled([submit(one), submit(two)]);
    assert.ok(results.some(x => x.status === 'fulfilled'));
    assert.equal((await one.inspect(actor)).orders.length, 1);
    assert.equal((await submit(two)).key, 'paper-one');
    const name = createHash('sha256').update('paper-tenant:1').digest('hex');
    await writeFile(join(directory, `${name}.json`), '{not valid json');
    await assert.rejects(two.inspect(actor), /corrupt/);
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('smartexit-paper-')) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable fill identities prevent timeout/restart retries from applying partial fills twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smartexit-paper-'));
  try {
    const service = await setup('PAPER_AUTOPILOT', new AtomicFilePaperJournal(directory));
    const f = inputs(); await submit(service, f);
    const first = await service.fill(actor, 'paper-one', 'execution-1', 2, f.market, now);
    const restarted = new TenantPaperService(new AtomicFilePaperJournal(directory));
    await restarted.setSafety(actor, { killSwitch: true, exchangeAvailable: false }, now + 1);
    const retry = await restarted.fill(actor, 'paper-one', 'execution-1', 2, f.market, now + 2);
    assert.deepEqual(retry, first);
    const state = await restarted.inspect(actor);
    assert.equal(state.orders[0].filledQuantity, 2);
    assert.equal(state.orders[0].fees, first.fees);
    assert.equal(state.orders[0].fills.length, 1);
    assert.equal(state.audit.filter(x => x.action === 'PAPER_FILL').length, 1);
    await assert.rejects(restarted.fill(actor, 'paper-one', 'execution-1', 3, f.market, now + 2), /conflicts/);
    assert.equal((await restarted.inspect(actor)).orders[0].filledQuantity, 2);
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('smartexit-paper-')) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

test('switching to Observe pauses existing reservations and partial fills while permitting risk-reducing close', async () => {
  const service = await setup(), f = inputs(); await submit(service, f);
  await service.fill(actor, 'paper-one', 'initial-fill', 1, f.market, now);
  await service.configure(actor, defaultPaperConfiguration(), now + 1);
  await assert.rejects(service.fill(actor, 'paper-one', 'new-fill', 1, f.market, now + 2), /Observe mode/);
  assert.equal((await service.inspect(actor)).orders[0].filledQuantity, 1);
  assert.equal((await service.close(actor, 'paper-one', f.market, now + 2)).status, 'CLOSED');
  const unfilled = await setup(); await submit(unfilled, f);
  await unfilled.configure(actor, defaultPaperConfiguration(), now + 1);
  await assert.rejects(unfilled.fill(actor, 'paper-one', 'new-fill', 1, f.market, now + 2), /Observe mode/);
  assert.equal((await unfilled.inspect(actor)).orders[0].filledQuantity, 0);
});
