import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_EXECUTION_DIAGNOSTICS,
  evaluateSignalAutoExecution,
} from './auto-execution-diagnostics.ts';

test('AUTO_EXECUTION_DIAGNOSTICS dictionary defines all required structured reason codes', () => {
  const requiredCodes = [
    'WORKER_OFFLINE',
    'SIGNAL_NOT_READY',
    'ENTRY_EXPIRED',
    'AUTOMATIC_MODE_DISABLED',
    'EXCHANGE_DISABLED',
    'PROVIDER_DISABLED',
    'DEMO_CREDENTIALS_MISSING',
    'DEMO_CREDENTIALS_INVALID',
    'ADAPTER_INCOMPLETE',
    'DATABASE_SCHEMA_MISSING',
    'INSUFFICIENT_AVAILABLE_BALANCE',
    'MINIMUM_ORDER_NOTIONAL',
    'RISK_LIMIT_EXCEEDED',
    'DUPLICATE_EXECUTION',
    'EMERGENCY_STOP_ACTIVE',
    'EXCHANGE_ORDER_REJECTED',
    'PROTECTION_INSTALLATION_FAILED',
    'LIVE_TRADING_LOCKED',
    'READY_TO_DISPATCH',
    'EXECUTED_DEMO',
  ];

  for (const code of requiredCodes) {
    const meta = AUTO_EXECUTION_DIAGNOSTICS[code];
    assert.ok(meta, `Metadata for ${code} must exist`);
    assert.equal(meta.code, code);
    assert.ok(meta.badgeLabel.length > 0, `badgeLabel for ${code} must not be empty`);
    assert.ok(meta.title.length > 0, `title for ${code} must not be empty`);
    assert.ok(meta.description.length > 0, `description for ${code} must not be empty`);
    assert.ok(meta.actionHint.length > 0, `actionHint for ${code} must not be empty`);
  }
});

test('evaluateSignalAutoExecution returns LIVE_TRADING_LOCKED for live environment', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'LIVE',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
  });
  assert.equal(result.code, 'LIVE_TRADING_LOCKED');
});

test('evaluateSignalAutoExecution returns EMERGENCY_STOP_ACTIVE when emergency stop is active', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    emergencyStop: true,
  });
  assert.equal(result.code, 'EMERGENCY_STOP_ACTIVE');
});

test('evaluateSignalAutoExecution returns EXECUTED_DEMO when execution already exists', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    existingExecution: true,
  });
  assert.equal(result.code, 'EXECUTED_DEMO');
});

test('evaluateSignalAutoExecution returns SIGNAL_NOT_READY when score < 60 or setup missing', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'WAIT',
    side: 'WAIT',
    hasSetup: false,
  });
  assert.equal(result.code, 'SIGNAL_NOT_READY');
});

test('evaluateSignalAutoExecution returns ENTRY_EXPIRED when price has already touched TP1', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    entryPrice: 100,
    currentMarkPrice: 108,
    tp1: 105,
  });
  assert.equal(result.code, 'ENTRY_EXPIRED');
});

test('evaluateSignalAutoExecution returns WORKER_OFFLINE when worker is not active', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    workerActive: false,
  });
  assert.equal(result.code, 'WORKER_OFFLINE');
});

test('evaluateSignalAutoExecution returns AUTOMATIC_MODE_DISABLED when auto mode is off', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    workerActive: true,
    autoTradingEnabled: false,
  });
  assert.equal(result.code, 'AUTOMATIC_MODE_DISABLED');
});

test('evaluateSignalAutoExecution returns DEMO_CREDENTIALS_MISSING when credentials not set', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    workerActive: true,
    autoTradingEnabled: true,
    exchangeEnabled: true,
    hasCredentials: false,
  });
  assert.equal(result.code, 'DEMO_CREDENTIALS_MISSING');
});

test('evaluateSignalAutoExecution returns READY_TO_DISPATCH when all preconditions pass', () => {
  const result = evaluateSignalAutoExecution({
    environment: 'DEMO',
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    workerActive: true,
    autoTradingEnabled: true,
    exchangeEnabled: true,
    hasCredentials: true,
    currentMarkPrice: 101,
    tp1: 105,
    entryPrice: 100,
  });
  assert.equal(result.code, 'READY_TO_DISPATCH');
});
