import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSignalAutoExecution } from '../lib/auto-execution-diagnostics.ts';

test('Offline Demo Execution Pipeline: LIVE trading locked fail-closed, DEMO eligible when armed', () => {
  const baseSignal = {
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    score: 84,
    entryPrice: 95000,
    currentMarkPrice: 95020,
    tp1: 96500,
    entryZoneLow: 94800,
    entryZoneHigh: 95200,
    isExpired: false,
    workerActive: true,
    autoTradingEnabled: true,
    exchangeEnabled: true,
    hasCredentials: true,
    emergencyStop: false,
    existingExecution: false,
  };

  // 1. LIVE environment must always fail closed
  const liveAttempt = evaluateSignalAutoExecution({ ...baseSignal, environment: 'LIVE' });
  assert.equal(liveAttempt.code, 'LIVE_TRADING_LOCKED');
  assert.equal(liveAttempt.category, 'LOCKED');

  // 2. Emergency stop blocks execution
  const emergency = evaluateSignalAutoExecution({ ...baseSignal, environment: 'DEMO', emergencyStop: true });
  assert.equal(emergency.code, 'EMERGENCY_STOP_ACTIVE');
  assert.equal(emergency.category, 'BLOCKED');

  // 3. Duplicate execution prevented
  const duplicate = evaluateSignalAutoExecution({ ...baseSignal, environment: 'DEMO', existingExecution: true });
  assert.equal(duplicate.code, 'EXECUTED_DEMO');

  // 4. Valid DEMO / TESTNET armed admission
  const demoArmed = evaluateSignalAutoExecution({ ...baseSignal, environment: 'DEMO' });
  assert.equal(demoArmed.code, 'READY_TO_DISPATCH');
  assert.equal(demoArmed.category, 'ARMED');

  const testnetArmed = evaluateSignalAutoExecution({ ...baseSignal, environment: 'TESTNET' });
  assert.equal(testnetArmed.code, 'READY_TO_DISPATCH');
  assert.equal(testnetArmed.category, 'ARMED');
});

test('Offline Demo Execution Pipeline: blocks missing credentials, expired entry, and TP1-already-crossed signals', () => {
  const missingCreds = evaluateSignalAutoExecution({
    status: 'READY',
    side: 'SHORT',
    hasSetup: true,
    environment: 'DEMO',
    hasCredentials: false,
  });
  assert.equal(missingCreds.code, 'DEMO_CREDENTIALS_MISSING');

  const tp1Crossed = evaluateSignalAutoExecution({
    status: 'READY',
    side: 'LONG',
    hasSetup: true,
    environment: 'DEMO',
    currentMarkPrice: 97000,
    tp1: 96500,
  });
  assert.equal(tp1Crossed.code, 'ENTRY_EXPIRED');
});
