import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateHistoricalSignal } from './backtesting-engine.ts';

const standard = {
  id: 'standard-fixture', strategy: 'STANDARD', side: 'LONG',
  generatedAt: 100, entryExpiresAt: 300, expiresAt: 600, candleIntervalMs: 100,
  entryPrice: 100, entryZoneLow: 99, entryZoneHigh: 101, stop: 90,
  tp1: 110, tp2: 120, tp3: 130,
};
const candle = (openTime, open, high, low, close = open) => ({
  openTime, closeTime: openTime + 99, open, high, low, close,
});

test('High-Risk strategy parity closes the whole position at TP2 when no TP3 exists', () => {
  const bars = [candle(100, 100, 111, 94), candle(200, 112, 121, 106)];
  const result = evaluateHistoricalSignal({ ...standard, strategy: 'HIGH_RISK', tp3: null }, bars, 300);
  assert.equal(result.status, 'TP2_HIT');
  assert.equal(result.simulatedExit, 120);
  assert.deepEqual(result.events.map(event => event.type), ['ENTRY_REACHED', 'TP1_HIT', 'TP2_HIT']);
  assert.throws(() => evaluateHistoricalSignal({ ...standard, tp3: null }, bars, 300), /Standard requires TP3/);
});

test('Standard TP1 and TP2 retain full exposure until TP3', () => {
  const bars = [candle(100, 100, 110, 94), candle(200, 112, 120, 100), candle(300, 121, 130, 118)];
  const opened = evaluateHistoricalSignal(standard, bars, 300);
  assert.equal(opened.status, 'OPEN');
  assert.equal(opened.simulatedExit, null);
  assert.equal(opened.grossReturnPercent, null);
  assert.deepEqual(opened.events.map(event => event.type), ['ENTRY_REACHED', 'TP1_HIT', 'TP2_HIT']);
  const closed = evaluateHistoricalSignal(standard, bars, 400);
  assert.equal(closed.status, 'TP3_HIT');
  assert.equal(closed.simulatedExit, 130);
  assert.equal(closed.grossReturnPercent, 30);
  assert.equal(closed.grossRiskMultiple, 3);
  assert.deepEqual(closed.events.at(-1), { type: 'TP3_HIT', price: 130, observedAt: 399 });
});

test('High-Risk SHORT does not realize TP2 gains and closes at TP3', () => {
  const short = { ...standard, id: 'short-fixture', strategy: 'HIGH_RISK', side: 'SHORT', stop: 110, tp1: 90, tp2: 80, tp3: 70 };
  const bars = [candle(100, 100, 105, 90), candle(200, 90, 98, 80), candle(300, 80, 88, 70)];
  assert.equal(evaluateHistoricalSignal(short, bars, 300).status, 'OPEN');
  const result = evaluateHistoricalSignal(short, bars, 400);
  assert.equal(result.status, 'TP3_HIT');
  assert.equal(result.grossReturnPercent, 30);
  assert.equal(result.grossRiskMultiple, 3);
});

test('stop after milestones closes full exposure and accounts for adverse opening gap', () => {
  const bars = [candle(100, 100, 122, 95), candle(200, 85, 125, 81, 102)];
  const result = evaluateHistoricalSignal(standard, bars, 300);
  assert.equal(result.status, 'STOP_LOSS_HIT');
  assert.equal(result.simulatedExit, 85);
  assert.equal(result.grossRiskMultiple, -1.5);
  assert.equal(result.grossReturnPercent, -15);
});

test('conflicting OHLC touches do not invent a favorable event sequence', () => {
  const both = evaluateHistoricalSignal(standard, [candle(100, 100, 132, 85)], 200);
  assert.equal(both.status, 'AMBIGUOUS');
  assert.equal(both.simulatedExit, null);
  assert.deepEqual(both.events.map(event => event.type), ['ENTRY_REACHED']);
  const entryAndTarget = evaluateHistoricalSignal(standard, [candle(100, 105, 112, 100)], 200);
  assert.equal(entryAndTarget.status, 'AMBIGUOUS');
  assert.equal(entryAndTarget.simulatedEntry, null);
});

test('known opening targets precede a later adverse wick', () => {
  const bars = [candle(100, 100, 105, 95), candle(200, 132, 134, 88)];
  const result = evaluateHistoricalSignal(standard, bars, 300);
  assert.equal(result.status, 'TP3_HIT');
  assert.equal(result.simulatedExit, 130);
  assert.equal(result.events.at(-1).observedAt, 200);
});

test('checks candle gaps, discards partial and pre-signal bars, and rejects ambiguous deadline bars', () => {
  assert.equal(evaluateHistoricalSignal(standard, [candle(200, 100, 107, 99)], 300).status, 'DATA_INCOMPLETE');
  const midBar = { ...standard, generatedAt: 125, entryExpiresAt: 250 };
  assert.equal(evaluateHistoricalSignal(midBar, [candle(100, 100, 130, 85)], 200).status, 'WAITING_ENTRY');
  assert.equal(evaluateHistoricalSignal(midBar, [candle(200, 100, 104, 98)], 250).status, 'DATA_INCOMPLETE');
  assert.equal(evaluateHistoricalSignal(midBar, [candle(200, 100, 104, 98)], 300).status, 'AMBIGUOUS');
});

test('distinguishes entry invalidation, missed opportunities and unresolved expirations', () => {
  assert.equal(evaluateHistoricalSignal(standard, [candle(100, 97, 98, 90)], 200).status, 'ENTRY_INVALIDATED');
  assert.equal(evaluateHistoricalSignal(standard, [candle(100, 102, 115, 102)], 200).status, 'MISSED');
  const bars = [100, 200, 300, 400, 500].map(time => candle(time, 100, 104, 98));
  assert.equal(evaluateHistoricalSignal(standard, bars, 600).status, 'EXPIRED');
  assert.throws(() => evaluateHistoricalSignal({ ...standard, tp3: 120 }, bars, 600), RangeError);
});
