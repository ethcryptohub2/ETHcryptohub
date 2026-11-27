import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'adaptive-protection.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);

const {
  computeAdaptiveProtection,
  identifySwingLevels,
  validateSmartEntryFilters,
} = sourceModule.exports;

function createMockCandles(count = 30, startPrice = 100, trend = 0.5) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + trend + (Math.sin(i) * 0.5);
    const high = Math.max(open, close) + 0.8;
    const low = Math.min(open, close) - 0.8;
    const volume = 1000 + (i * 20);
    candles.push({ open, high, low, close, volume });
    price = close;
  }
  return candles;
}

test('identifySwingLevels detects swing highs and lows in candlestick series', () => {
  const candles = [
    { open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { open: 11, high: 14, low: 10, close: 13, volume: 100 },
    { open: 13, high: 18, low: 12, close: 16, volume: 100 }, // Swing high at 18
    { open: 16, high: 15, low: 11, close: 12, volume: 100 },
    { open: 12, high: 13, low: 8, close: 9, volume: 100 },   // Swing low at 8
    { open: 9, high: 11, low: 8.5, close: 10, volume: 100 },
    { open: 10, high: 12, low: 9.5, close: 11, volume: 100 },
  ];
  const swings = identifySwingLevels(candles, 10);
  assert.equal(swings.swingHigh, 18);
  assert.equal(swings.swingLow, 8);
});

test('computeAdaptiveProtection calculates LONG adaptive stop loss and 1R/2.75R targets', () => {
  const candles = createMockCandles(30, 100, 0.2);
  const entryPrice = 105;
  const res = computeAdaptiveProtection({
    candles,
    side: 'LONG',
    entryPrice,
    baselineStop: 103,
    baselineTp1: 107,
    baselineTp2: 109,
    baselineTp3: 112,
    mode: 'ADAPTIVE_SMART',
    atrMultiplier: 2.0,
    minRiskDistancePct: 0.015,
  });

  assert.equal(res.isValid, true);
  assert.equal(res.mode, 'ADAPTIVE_SMART');
  assert.ok(res.stopLoss < entryPrice, 'Stop loss must be below entry for LONG');
  assert.ok(res.tp1 > entryPrice, 'TP1 must be above entry for LONG');
  assert.ok(res.tp2 > res.tp1, 'TP2 must be above TP1');
  assert.ok(res.tp3 > res.tp2, 'TP3 must be above TP2');
  assert.ok(res.riskDistancePct >= 0.015, 'Enforces 1.5% minimum stop distance');
  assert.ok(res.rewardRiskRatio >= 1.0, 'TP1 must represent at least 1R');
});

test('computeAdaptiveProtection calculates SHORT adaptive stop loss and targets', () => {
  const candles = createMockCandles(30, 100, -0.2);
  const entryPrice = 95;
  const res = computeAdaptiveProtection({
    candles,
    side: 'SHORT',
    entryPrice,
    baselineStop: 97,
    baselineTp1: 93,
    baselineTp2: 91,
    baselineTp3: 88,
    mode: 'ADAPTIVE_SMART',
    atrMultiplier: 2.0,
    minRiskDistancePct: 0.015,
  });

  assert.equal(res.isValid, true);
  assert.ok(res.stopLoss > entryPrice, 'Stop loss must be above entry for SHORT');
  assert.ok(res.tp1 < entryPrice, 'TP1 must be below entry for SHORT');
  assert.ok(res.tp2 < res.tp1, 'TP2 must be below TP1 for SHORT');
  assert.ok(res.tp3 < res.tp2, 'TP3 must be below TP2 for SHORT');
});

test('computeAdaptiveProtection rejects excessive risk distance (>8%)', () => {
  const candles = createMockCandles(30, 100, 0.1);
  const res = computeAdaptiveProtection({
    candles,
    side: 'LONG',
    entryPrice: 100,
    baselineStop: 80, // 20% away
    baselineTp1: 120,
    baselineTp2: 130,
    baselineTp3: 140,
    mode: 'BASELINE',
    maxRiskDistancePct: 0.08,
  });
  assert.equal(res.isValid, false);
  assert.match(res.rejectionReason, /exceeds maximum risk threshold/);
});

test('validateSmartEntryFilters detects outsized impulse candles', () => {
  const candles = createMockCandles(25, 100, 0.1);
  candles.push({ open: 105, high: 130, low: 104, close: 128, volume: 10000 });
  const filter = validateSmartEntryFilters({
    candles,
    side: 'LONG',
  });
  assert.equal(filter.indicators.impulseCandleDetected, true);
  assert.equal(filter.passed, false, 'Impulse candle must fail the filter');
});
