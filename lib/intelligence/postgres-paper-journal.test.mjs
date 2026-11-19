import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
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
const paper = compile('./tenant-paper.ts', { './risk-governor': risk });
const schema = compile('./paper-state-schema.ts', { './risk-governor': risk });
const { PostgresPaperJournal } = compile('./postgres-paper-journal.ts', { './tenant-paper': paper, './paper-state-schema': schema });
function database() {
  const rows = new Map(), statements = [], releases = [];
  let tail = Promise.resolve();
  const db = { rows, statements, releases, commitFailure: false, conflict: false,
    async connect() {
      let unlock, pending;
      return {
        release(discard) { releases.push(Boolean(discard)); },
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (sql === 'BEGIN') { pending = new Map(); return { rows: [] }; }
          if (sql.startsWith('SET LOCAL')) return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) {
            const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
            return { rows: [] };
          }
          if (sql.startsWith('SELECT state')) {
            const row = rows.get(params[0]); return { rows: row ? [structuredClone(row)] : [] };
          }
          if (sql.startsWith('INSERT')) {
            if (db.conflict || rows.has(params[0])) return { rowCount: 0 };
            pending.set(params[0], { state: JSON.parse(params[2]), revision: String(params[1]) }); return { rowCount: 1 };
          }
          if (sql.startsWith('UPDATE')) {
            if (db.conflict || rows.get(params[2])?.revision !== String(params[3])) return { rowCount: 0 };
            pending.set(params[2], { state: JSON.parse(params[0]), revision: String(params[1]) }); return { rowCount: 1 };
          }
          if (sql === 'COMMIT') {
            for (const [key, value] of pending) rows.set(key, value);
            unlock?.(); unlock = null;
            if (db.commitFailure) throw new Error('connection lost after commit');
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') { unlock?.(); unlock = null; return { rows: [] }; }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
  };
  return db;
}
const actor = id => ({ userId: id, tenantId: id });
const now = 1_800_000_000_000;
async function configure(db, id = 1) {
  const journal = new PostgresPaperJournal(db, actor(id));
  const service = new paper.TenantPaperService(journal);
  await service.configure(actor(id), paper.defaultPaperConfiguration(), now);
  return { journal, service };
}
test('database adapter rejects untrusted tenant selection before acquiring any connection', async () => {
  const db = database();
  assert.throws(() => new PostgresPaperJournal(db, { userId: 2, tenantId: 1 }), /ownership/);
  const journal = new PostgresPaperJournal(db, actor(1));
  await assert.rejects(journal.read(2), /ownership/);
  await assert.rejects(journal.transact(2, () => { throw new Error('must not run'); }), /ownership/);
  assert.equal(db.statements.length, 0);
});
test('two first-write callbacks serialize; populated tenants stay isolated across adapter restart', async () => {
  const db = database();
  const first = new paper.TenantPaperService(new PostgresPaperJournal(db, actor(1)));
  const second = new paper.TenantPaperService(new PostgresPaperJournal(db, actor(1)));
  await Promise.all([first.configure(actor(1), paper.defaultPaperConfiguration(), now), second.configure(actor(1), paper.defaultPaperConfiguration(), now)]);
  await configure(db, 2);
  const restarted = new PostgresPaperJournal(db, actor(1));
  assert.equal((await restarted.read(1)).revision, 2);
  assert.equal(db.rows.get(2).state.revision, 1);
  const result = await restarted.transact(1, state => { state.killSwitch = true; state.revision++; return { state, result: 'locked' }; });
  assert.equal(result, 'locked');
  assert.equal(db.rows.get(2).state.killSwitch, false);
  assert.equal((await restarted.read(1)).killSwitch, true);
  assert.ok(db.statements.some(s => s.sql.endsWith('FOR UPDATE')));
  assert.ok(db.statements.filter(s => /WHERE tenant_user_id/.test(s.sql)).every(s => s.params.includes(1) || s.params.includes(2)));
});
test('idempotent callback acknowledges without rewrite; unversioned mutation and conflict roll back', async () => {
  const db = database(), { journal } = await configure(db);
  const writes = () => db.statements.filter(s => /^(INSERT|UPDATE)/.test(s.sql)).length;
  await journal.transact(1, state => ({ state, result: 'same acknowledgement' }));
  assert.equal(writes(), 1);
  await assert.rejects(journal.transact(1, state => { state.equity = 1; return { state, result: null }; }), /revision conflict/);
  assert.equal(db.rows.get(1).state.equity, 10_000);
  db.conflict = true;
  await assert.rejects(journal.transact(1, state => { state.revision++; return { state, result: null }; }), /revision conflict/);
  assert.equal(db.rows.get(1).revision, '1');
  assert.ok(db.statements.some(s => s.sql === 'ROLLBACK'));
});
test('malformed row, tenant substitution and credential-bearing state fail closed', async () => {
  const db = database(), { journal } = await configure(db);
  await assert.rejects(journal.transact(1, state => { state.tenantId = 2; return { state, result: null }; }), /invalid/);
  await assert.rejects(journal.transact(1, state => { state.revision++; state.configuration.apiSecret = 'fixture-only'; return { state, result: null }; }), /invalid|credential/);
  db.rows.get(1).revision = '999';
  await assert.rejects(journal.read(1), /invalid/);
});
test('unknown commit outcome discards connection and never automatically replays callback', async () => {
  const db = database(), { journal } = await configure(db);
  db.commitFailure = true; let calls = 0;
  await assert.rejects(journal.transact(1, state => { calls++; state.revision++; state.killSwitch = true; return { state, result: null }; }), /outcome is unknown/);
  assert.equal(calls, 1);
  assert.equal(db.releases.at(-1), true);
  assert.equal((await journal.read(1)).killSwitch, true);
});
test('callback exceptions and nonserializable acknowledgements roll back without committing', async () => {
  const db = database(), { journal } = await configure(db);
  await assert.rejects(journal.transact(1, () => { throw new Error('risk rejection'); }), /risk rejection/);
  await assert.rejects(journal.transact(1, state => { state.revision++; return { state, result: () => {} }; }));
  assert.equal(db.rows.get(1).revision, '1');
});
test('nested corrupted account, policy, audit and order metadata never reaches a write', async () => {
  const db = database(), { journal } = await configure(db);
  for (const mutate of [
    state => { state.peakEquity = NaN; },
    state => { state.dayStartEquity = 'unknown'; },
    state => { state.configuration.policy.allowedStrategies = ['LIVE']; },
    state => { state.audit[0].metadata = { key: 'fixture-only' }; },
    state => { state.audit[0].sequence = 999; },
  ]) await assert.rejects(journal.transact(1, state => { mutate(state); state.revision++; return { state, result: null }; }), /invalid/);
  await assert.rejects(journal.transact(1, async state => ({ state, result: null })), /synchronous/);
  assert.equal(db.rows.get(1).revision, '1');
});
test('real service recovers reservation and partial-fill commit loss using original durable identities', async () => {
  const db = database();
  let service = new paper.TenantPaperService(new PostgresPaperJournal(db, actor(1)));
  await service.configure(actor(1), { ...paper.defaultPaperConfiguration(), mode: 'PAPER_AUTOPILOT' }, now);
  const intent = { idempotencyKey: 'reservation-one', symbol: 'BTCUSDT', side: 'LONG', quantity: 10,
    entryPrice: 100, stopPrice: 95, leverage: 2, estimatedLiquidationPrice: 50, correlationGroup: 'MAJORS' };
  const market = { symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: now, receivedAt: now,
    price: 100, bid: 99.9, ask: 100, quoteVolume: 1_000_000, buyQuoteVolume: 600_000,
    sellQuoteVolume: 400_000, bidDepth: 100_000, askDepth: 90_000, fresh: true, sequenceValid: true };
  const signal = { id: 'research-one', symbol: 'BTCUSDT', strategy: 'STANDARD', classification: 'READY_FOR_RESEARCH',
    side: 'LONG', score: 100, observedAt: now, expiresAt: now + 60_000, reasons: [], evidence: {} };
  db.commitFailure = true;
  await assert.rejects(service.submit(actor(1), intent, market, signal, now), /outcome is unknown/);
  db.commitFailure = false;
  service = new paper.TenantPaperService(new PostgresPaperJournal(db, actor(1)));
  assert.equal((await service.submit(actor(1), intent, market, signal, now)).status, 'RESERVED');
  assert.equal((await service.inspect(actor(1))).orders.length, 1);
  db.commitFailure = true;
  await assert.rejects(service.fill(actor(1), intent.idempotencyKey, 'durable-fill-one', 2, market, now), /outcome is unknown/);
  db.commitFailure = false;
  service = new paper.TenantPaperService(new PostgresPaperJournal(db, actor(1)));
  const before = await service.inspect(actor(1));
  const ack = await service.fill(actor(1), intent.idempotencyKey, 'durable-fill-one', 2, market, now + 10);
  const after = await service.inspect(actor(1));
  assert.equal(ack.filledQuantity, 2);
  assert.equal(after.orders[0].fills.length, 1);
  assert.equal(after.orders[0].filledQuantity, 2);
  assert.equal(after.equity, before.equity);
  assert.equal(after.revision, before.revision);
  await assert.rejects(service.fill(actor(1), intent.idempotencyKey, 'durable-fill-one', 3, market, now + 10), /conflicts/);
});
