#!/usr/bin/env node
/**
 * SmartExit Hybrid Parallel Scanner V2 — Reusable Staging Acceptance Test
 *
 * Usage:
 *   Offline (during Binance cooldown):
 *     node --import tsx scripts/acceptance-v2-post-cooldown.mjs --offline
 *
 *   Live (after Binance IP ban expires: 2026-11-29T06:04:31.334Z):
 *     node --import tsx scripts/acceptance-v2-post-cooldown.mjs --live --base-url=https://smartexit-staging.onrender.com
 */
import assert from 'node:assert/strict';
import { binanceRateLimiter } from '../lib/binance-rate-limit.ts';
import { RollingCandleCache, timeframeToMs } from '../lib/candle-cache.ts';
import { runHybridParallelWorkPool } from '../lib/hybrid-scanner-v2.ts';
import { evaluateSignalAutoExecution } from '../lib/auto-execution-diagnostics.ts';

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const baseUrlArg = args.find((a) => a.startsWith('--base-url='));
const baseUrl = baseUrlArg ? baseUrlArg.split('=')[1] : 'https://smartexit-staging.onrender.com';

async function runOfflineAcceptance() {
  console.log('[Acceptance V2] Running OFFLINE deterministic acceptance suite...');

  // 1. Dynamic 528-symbol V2 parallel pool
  binanceRateLimiter.reset();
  const symbols = Array.from({ length: 528 }, (_, i) => `PAIR${i + 1}USDT`);
  const summary = await runHybridParallelWorkPool({
    cycleId: 'OFFLINE-ACCEPTANCE',
    symbols,
    batchSize: 32,
    concurrency: 4,
    processBatch: async (batch) => ({
      successfulCount: batch.length,
      failedCount: 0,
      skippedCount: 0,
      qualifiedCount: 0,
      newSignals: 0,
      deduplicatedSignals: 0,
    }),
  });
  assert.equal(summary.state, 'COMPLETED');
  assert.equal(summary.coveragePercent, 100);
  console.log(`  ✔ V2 4-worker pool: 528/528 symbols, 17/17 batches, ${summary.durationMs}ms`);

  // 2. Shared rolling candle cache & incremental WS update (420-candle production capacity)
  const cache = new RollingCandleCache();
  const intervalMs = timeframeToMs('15m');
  const now = Date.now();
  const aligned = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const candles = Array.from({ length: 420 }, (_, i) => {
    const t = aligned - (419 - i) * intervalMs;
    return { openTime: t, high: 102, low: 98, close: 100, volume: 1000, closeTime: t + intervalMs - 1 };
  });
  cache.setHistory('BINANCE', 'BTCUSDT', '15m', candles, now);
  const assessed = cache.assess('BINANCE', 'BTCUSDT', '15m', now, false);
  assert.equal(assessed.status, 'FRESH_LIVE');
  assert.equal(assessed.candles.length, 420);
  console.log('  ✔ Shared rolling candle cache: 420-candle warm-up & freshness validated');

  // 3. Fail-closed LIVE trading & Demo readiness
  assert.equal(
    evaluateSignalAutoExecution({ status: 'READY', side: 'LONG', hasSetup: true, environment: 'LIVE' }).code,
    'LIVE_TRADING_LOCKED',
  );
  assert.equal(
    evaluateSignalAutoExecution({ status: 'READY', side: 'LONG', hasSetup: true, environment: 'DEMO', hasCredentials: true }).code,
    'READY_TO_DISPATCH',
  );
  console.log('  ✔ Trading safety: LIVE locked fail-closed, DEMO armed admission validated');
  console.log('[Acceptance V2] OFFLINE ACCEPTANCE PASSED.');
}

async function runLiveAcceptance() {
  console.log(`[Acceptance V2] Running LIVE post-cooldown acceptance against ${baseUrl}...`);
  const envRes = await fetch(`${baseUrl}/api/environment`, { cache: 'no-store' });
  assert.equal(envRes.status, 200, 'Environment endpoint must respond HTTP 200');
  const envJson = await envRes.json();
  console.log('  ✔ Environment:', JSON.stringify(envJson));

  // Verify audio assets served
  for (const file of ['/audio/alarm_tone.mp3', '/audio/alarm.mp3']) {
    const audioRes = await fetch(`${baseUrl}${file}`, { method: 'HEAD' });
    assert.equal(audioRes.status, 200, `${file} must return HTTP 200`);
  }
  console.log('  ✔ Owner audio assets: alarm_tone.mp3 and alarm.mp3 HTTP 200');

  // Note: authenticated scanner & preference checks require session cookie
  console.log('  ℹ For full authenticated V2 cycle check after 2026-11-29T06:04:31.334Z, run authenticated POST /api/scanner/scan and verify v2State.state === COMPLETED & cooldownUntil === null.');
}

if (isLive) {
  await runLiveAcceptance();
} else {
  await runOfflineAcceptance();
}
