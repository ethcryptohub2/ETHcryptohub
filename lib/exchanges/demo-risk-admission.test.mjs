import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
function load(filename, mocks = {}) {
  const source = path.resolve(directory, filename);
  const fixture = new Module(source);
  fixture.filename = source;
  fixture.paths = Module._nodeModulePaths(path.dirname(source));
  const require = fixture.require.bind(fixture);
  fixture.require = key => key in mocks ? mocks[key] : require(key);
  fixture._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, source);
  return fixture.exports;
}
const providers = load('../admin-demo-provider-contract.ts');
const { evaluateDemoRiskAdmission } = load('./demo-risk-admission.ts', {
  '../admin-demo-provider-contract': providers,
});

const now = Date.parse('2026-11-21T14:00:00Z');
function evidence() {
  const scope = { adminId: 9, accountId: 'a7c913eb-d834-476c-952e-47c25b6c7c7c', provider: 'BYBIT', environment: 'DEMO' };
  return {
    scope, now,
    policy: { maximumNotional: '10000', maximumPositions: 3, maximumDailyOrders: 2, maximumDailyLoss: '200',
      allowedSymbols: ['BTCUSDT'], allowedStrategies: ['STANDARD'] },
    account: { scope: { ...scope }, observedAt: now - 1000, utcDay: '2026-11-21', complete: true,
      emergencyStop: false, equity: '10000', realizedDailyPnl: '0', positions: 0, reservedEntrySlots: 0,
      admittedOrdersToday: 0, openNotional: '0', reservedNotional: '0', existingRisk: '0' },
    intent: { symbol: 'BTCUSDT', strategy: 'STANDARD', side: 'LONG', quantity: '1', entry: '1000', stop: '900' },
  };
}

test('hard 1% boundary accepts equality and rejects an exact sub-cent overshoot', () => {
  const input = evidence();
  assert.deepEqual(evaluateDemoRiskAdmission(input), { allowed: true, reasons: [] });
  input.intent.quantity = '1.000000000001';
  assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, ['ONE_PERCENT_RISK_LIMIT']);
  input.intent.quantity = '1';
  input.intent.side = 'SHORT';
  assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, ['INVALID_LIMITS_OR_ORDER_SIZE']);
  input.intent.stop = '1100';
  assert.equal(evaluateDemoRiskAdmission(input).allowed, true);
});

test('pending entry reservations consume notional, position slots, and daily risk budget', () => {
  const input = evidence();
  Object.assign(input.account, { positions: 1, reservedEntrySlots: 2, admittedOrdersToday: 2,
    openNotional: '4000', reservedNotional: '5000.000000000001', existingRisk: '101' });
  assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, [
    'MAXIMUM_POSITIONS', 'MAXIMUM_DAILY_ORDERS', 'MAXIMUM_NOTIONAL', 'DAILY_LOSS_LIMIT',
  ]);
  input.account.realizedDailyPnl = '100';
  assert.ok(evaluateDemoRiskAdmission(input).reasons.includes('DAILY_LOSS_LIMIT'));
  Object.assign(input.account, { existingRisk: '0', realizedDailyPnl: '-200' });
  assert.ok(evaluateDemoRiskAdmission(input).reasons.includes('DAILY_LOSS_LIMIT'));
});

test('missing evidence, wrong UTC day, mismatched account, and emergency stop fail closed', () => {
  const input = evidence();
  Object.assign(input.account, { observedAt: now + 1, utcDay: '2026-11-20', emergencyStop: true });
  input.account.scope.adminId = 10;
  input.intent.strategy = 'HIGH_RISK';
  input.intent.symbol = 'ETHUSDT';
  assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, [
    'ACCOUNT_SCOPE_MISMATCH', 'EMERGENCY_STOP', 'STALE_ACCOUNT_EVIDENCE', 'SYMBOL_NOT_APPROVED', 'STRATEGY_NOT_APPROVED',
  ]);
  input.account.complete = false;
  assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, ['INVALID_OR_INCOMPLETE_RISK_EVIDENCE']);
  input.account.complete = true;
  input.intent.strategy = 'ALPHA';
  assert.equal(evaluateDemoRiskAdmission(input).allowed, false);
});

test('all provider/environment scopes are explicit and live cannot be supplied', () => {
  for (const [provider, environment] of Object.entries(providers.ADMIN_DEMO_PROVIDER_ENVIRONMENTS)) {
    const input = evidence();
    Object.assign(input.scope, { provider, environment });
    Object.assign(input.account.scope, input.scope);
    assert.equal(evaluateDemoRiskAdmission(input).allowed, true, provider);
    input.scope.environment = environment === 'DEMO' ? 'TESTNET' : 'DEMO';
    input.account.scope.environment = input.scope.environment;
    assert.deepEqual(evaluateDemoRiskAdmission(input).reasons, ['ACCOUNT_SCOPE_MISMATCH']);
    input.scope.environment = 'LIVE';
    assert.equal(evaluateDemoRiskAdmission(input).allowed, false);
  }
});

const autoDispatcher = load('./demo-auto-dispatch.ts', {
  './demo-risk-admission': load('./demo-risk-admission.ts', { '../admin-demo-provider-contract': providers }),
});

function reservationFixture() {
  const data = evidence();
  const input = { scope: data.scope, intent: data.intent, account: data.account, clientKey: 'fixture-key', signalId: '1', quoteAsset: 'USDT' };
  const approvals = { enabled: true, identity: 'approval-fixture', stopAfterFence: false };
  const ledger = new Map();
  const audits = [];
  const sent = [];
  let previous = Promise.resolve();
  let connections = 0;
  let providerResult = order => ({
    reservationId: order.reservationId, provider: order.scope.provider, environment: order.scope.environment,
    accountId: order.scope.accountId, clientKey: order.clientKey, entryOrderId: 'entry', stopOrderId: 'stop',
    takeProfitOrderId: 'tp', independentlyVerified: true,
  });
  const dispatcher = autoDispatcher.createDemoAutoDispatcher({
    now: () => now,
    authorize: async () => true,
    dispatch: async order => { sent.push(order); return providerResult(order); },
    async connect() {
      connections++;
      let releaseLock;
      return {
        async query(sql, args = []) {
          if (sql.includes('FOR UPDATE OF a')) {
            const old = previous;
            previous = new Promise(resolve => { releaseLock = resolve; });
            await old;
            if (!approvals.enabled) return { rows: [] };
            return { rows: [{ risk_policy: data.policy, approval_identity: approvals.identity }] };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { releaseLock?.(); return { rows: [] }; }
          if (sql.includes('SELECT id, intent_sha')) return {
            rows: [...ledger.entries()].filter(([key, item]) => key === args[4] || item.signalId === args[5]).map(([, item]) => item),
          };
          if (sql.includes('FROM public.market_signals')) return { rows: [{ id: args[0] }] };
          if (sql.includes('AS day_orders')) return {
            rows: [{ slots: ledger.size, day_orders: ledger.size,
              notional: String(ledger.size * 1000), risk: String(ledger.size * 100) }],
          };
          if (sql.includes('INSERT INTO smartexit_demo_auto.reservations')) {
            ledger.set(args[4], { id: args[6], intent_sha: args[5], signalId: args[14] });
          }
          if (sql.includes('INSERT INTO smartexit_demo_auto.audit')) {
            audits.push(args[1]);
            if (args[1] === 'DISPATCHING' && approvals.stopAfterFence) approvals.identity = 'approval-changed';
          }
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  });
  return { dispatcher, input, approvals, ledger, audits, sent,
    connectionCount: () => connections, setProvider: value => { providerResult = value; } };
}

test('auto dispatcher is disabled without explicit reviewed adapters before storage is touched', async () => {
  const dispatcher = autoDispatcher.createDemoAutoDispatcher({ connect() { throw new Error('unexpected database'); } });
  assert.deepEqual(await dispatcher.execute(null), { state: 'BLOCKED', reasons: ['AUTO_DEMO_DISABLED'] });
});

test('parallel replay claims only one durable dispatch, and the claimed intent cannot be replaced', async () => {
  const f = reservationFixture();
  const results = await Promise.all([f.dispatcher.execute(f.input), f.dispatcher.execute(f.input)]);
  assert.deepEqual(results.map(row => row.state).sort(), ['PROTECTED', 'REPLAY']);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.audits, ['RESERVED', 'DISPATCHING', 'PROTECTED']);
  assert.equal((await f.dispatcher.execute({ ...f.input, clientKey: 'changed-key' })).state, 'REPLAY');
  const conflict = await f.dispatcher.execute({ ...f.input, intent: { ...f.input.intent, quantity: '0.5' } });
  assert.deepEqual(conflict, { state: 'BLOCKED', reasons: ['IDEMPOTENCY_CONFLICT'] });
});

test('pending reservations consume the daily limit and ambiguous outcomes cannot be resubmitted', async () => {
  const f = reservationFixture();
  f.setProvider(() => { throw new Error('simulated ambiguous provider response'); });
  assert.equal((await f.dispatcher.execute(f.input)).state, 'RECONCILIATION_REQUIRED');
  assert.equal((await f.dispatcher.execute(f.input)).state, 'REPLAY');
  assert.equal((await f.dispatcher.execute({ ...f.input, clientKey: 'another', signalId: '2' })).state, 'RECONCILIATION_REQUIRED');
  const excess = await f.dispatcher.execute({ ...f.input, clientKey: 'third', signalId: '3' });
  assert.ok(excess.reasons.includes('MAXIMUM_DAILY_ORDERS'));
  assert.equal(f.sent.length, 2);
});

test('changed approval after reservation and invalid protective-order evidence fail closed', async () => {
  const stopped = reservationFixture();
  stopped.approvals.enabled = false;
  assert.deepEqual(await stopped.dispatcher.execute(stopped.input), { state: 'BLOCKED', reasons: ['ACCOUNT_NOT_APPROVED_OR_STOPPED'] });
  assert.equal(stopped.ledger.size, 0);
  stopped.approvals.enabled = true;
  stopped.approvals.stopAfterFence = true;
  assert.equal((await stopped.dispatcher.execute(stopped.input)).state, 'RECONCILIATION_REQUIRED');
  assert.equal(stopped.sent.length, 0);
  const uncertain = reservationFixture();
  uncertain.setProvider(() => ({ independentlyVerified: false }));
  assert.equal((await uncertain.dispatcher.execute(uncertain.input)).state, 'RECONCILIATION_REQUIRED');
  assert.equal(uncertain.ledger.size, 1);
});
