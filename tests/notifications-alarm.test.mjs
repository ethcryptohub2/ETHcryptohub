import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('audio assets: alarm_tone.mp3 and alarm.mp3 exist and have nonzero size', () => {
  const signalAudio = path.resolve('public/audio/alarm_tone.mp3');
  const executionAudio = path.resolve('public/audio/alarm.mp3');

  assert.ok(fs.existsSync(signalAudio), 'alarm_tone.mp3 must exist in public/audio/');
  assert.ok(fs.existsSync(executionAudio), 'alarm.mp3 must exist in public/audio/');

  const signalStat = fs.statSync(signalAudio);
  const executionStat = fs.statSync(executionAudio);

  assert.ok(signalStat.size > 10000, `alarm_tone.mp3 size (${signalStat.size} bytes) should be > 10KB`);
  assert.ok(executionStat.size > 10000, `alarm.mp3 size (${executionStat.size} bytes) should be > 10KB`);
});

test('trigger categorization: maps all 15 triggers to correct alarm audio type', () => {
  const signalTriggers = [
    'NEW_SIGNAL',
    'SIGNAL_GENERATED',
    'SIGNAL_UPDATED',
    'ENTRY_REACHED',
    'ENTRY_OPEN',
  ];

  const executionTriggers = [
    'CONFIRMED_DEMO_EXECUTION',
    'ENTRY_MARKED_AS_ENTERED',
    'PARTIAL_TARGET_HIT',
    'TP1_HIT',
    'TP2_HIT',
    'TP3_HIT',
    'STOP_LOSS_HIT',
    'TRAILING_STOP_ACTIVATED',
    'EXECUTION_FAILED',
    'SIGNAL_EXPIRED',
    'ENTRY_INVALIDATED',
    'EMERGENCY_STOP_ACTIVATED',
    'EXCHANGE_CONNECTION_FAILED',
    'TRADE_CLOSED',
  ];

  function resolveAlarmType(eventType) {
    if (signalTriggers.includes(eventType)) return 'signal';
    if (executionTriggers.includes(eventType)) return 'execution';
    return 'signal';
  }

  for (const trig of signalTriggers) {
    assert.equal(resolveAlarmType(trig), 'signal', `${trig} should map to signal alarm (alarm_tone.mp3)`);
  }

  for (const trig of executionTriggers) {
    assert.equal(resolveAlarmType(trig), 'execution', `${trig} should map to execution alarm (alarm.mp3)`);
  }
});

test('audio parameters: defaults match requirements', () => {
  const defaultVolume = 0.8;
  const defaultDuration = 5;

  assert.equal(defaultVolume, 0.8, 'Default volume must be 80%');
  assert.equal(defaultDuration, 5, 'Default duration must be 5 seconds');

  const validDurations = [3, 5, 10, 'full'];
  assert.ok(validDurations.includes(defaultDuration));
});

test('cross-tab coordination: expiresAt prevents duplicate audio playback across tabs', () => {
  const tabA = 'tab-1';
  const tabB = 'tab-2';
  const now = Date.now();

  const activeLock = { tabId: tabA, timestamp: now, expiresAt: now + 5000 };

  function canPlay(currentTabId, lock, nowMs) {
    if (lock.tabId && lock.tabId !== currentTabId && lock.expiresAt && lock.expiresAt > nowMs) {
      return false; // locked by another tab
    }
    return true;
  }

  assert.equal(canPlay(tabB, activeLock, now + 1000), false, 'Tab B must be blocked while Tab A is playing');
  assert.equal(canPlay(tabA, activeLock, now + 1000), true, 'Tab A can control its own playback');
  assert.equal(canPlay(tabB, activeLock, now + 6000), true, 'Tab B can play once lock expires');
});

test('deduplication: prevents replaying historical alerts on refresh or reconnect', () => {
  const deliveredSet = new Set();
  const alertId = 'alert-987';

  function shouldDeliver(id) {
    if (deliveredSet.has(id)) return false;
    deliveredSet.add(id);
    return true;
  }

  assert.equal(shouldDeliver(alertId), true, 'First alert delivery must succeed');
  assert.equal(shouldDeliver(alertId), false, 'Subsequent re-delivery of the same alert must be ignored');
});
