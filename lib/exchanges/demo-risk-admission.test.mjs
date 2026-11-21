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
