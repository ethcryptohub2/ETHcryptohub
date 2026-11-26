import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceRateLimiter } from '../lib/binance-rate-limit.ts';
import { runHybridParallelWorkPool } from '../lib/hybrid-scanner-v2.ts';

function makeSymbols(count) {
  return Array.from({ length: count }, (_, i) => `COIN${i + 1}USDT`);
}

test('Offline Benchmark: 2, 4, and 6 workers across 528-symbol universe', async () => {
  const symbols = makeSymbols(528);
  const results = {};

  for (const concurrency of [2, 4, 6]) {
    binanceRateLimiter.reset();
    const cpuStart = process.cpuUsage();
    const memStart = process.memoryUsage().rss;
    const summary = await runHybridParallelWorkPool({
      cycleId: `BENCH-${concurrency}`,
      symbols,
      batchSize: 32,
      concurrency,
      processBatch: async (batch) => {
        // Simulate bounded network latency (12ms) + local indicator calculation
        await new Promise((r) => setTimeout(r, 12));
        let sum = 0;
        for (let i = 0; i < batch.length * 100; i += 1) sum += Math.sqrt(i + 1);
        assert.ok(sum > 0);
        return {
          successfulCount: batch.length,
          failedCount: 0,
          skippedCount: 0,
          qualifiedCount: 1,
          newSignals: 0,
          deduplicatedSignals: 1,
        };
      },
    });
    const cpuDiff = process.cpuUsage(cpuStart);
    const memEnd = process.memoryUsage().rss;

    assert.equal(summary.state, 'COMPLETED');
    assert.equal(summary.totalEligible, 528);
    assert.equal(summary.successfulCount, 528);
    assert.equal(summary.coveragePercent, 100);
    assert.equal(summary.totalBatches, 17);
    assert.equal(summary.completedBatches, 17);

    results[concurrency] = {
      durationMs: summary.durationMs,
      cpuUserMs: Math.round(cpuDiff.user / 1000),
      rssMb: Number((memEnd / 1024 / 1024).toFixed(2)),
      rssDeltaMb: Number(((memEnd - memStart) / 1024 / 1024).toFixed(2)),
    };
  }

  console.log('Hybrid Parallel V2 Worker Benchmark (528 symbols, 17 batches):', JSON.stringify(results));
  assert.ok(results[4].durationMs <= results[2].durationMs + 40);
});

test('Offline Hybrid V2: respects AbortSignal cancellation and counts skipped symbols', async () => {
  binanceRateLimiter.reset();
  const controller = new AbortController();
  const symbols = makeSymbols(160);

  const summary = await runHybridParallelWorkPool({
    cycleId: 'CANCEL-TEST',
    symbols,
    batchSize: 32,
    concurrency: 2,
    signal: controller.signal,
    processBatch: async (batch, batchIndex) => {
      if (batchIndex >= 2) controller.abort();
      await new Promise((r) => setTimeout(r, 5));
      return {
        successfulCount: batch.length,
        failedCount: 0,
        skippedCount: 0,
        qualifiedCount: 0,
        newSignals: 0,
        deduplicatedSignals: 0,
      };
    },
  });

  assert.ok(summary.skippedCount > 0);
  assert.equal(summary.successfulCount + summary.failedCount + summary.skippedCount, 160);
});

test('Offline Hybrid V2: halts unstarted batches immediately when HTTP 418 cooldown trips', async () => {
  binanceRateLimiter.reset();
  const symbols = makeSymbols(160);
  let batchesStarted = 0;

  const summary = await runHybridParallelWorkPool({
    cycleId: 'COOLDOWN-TEST',
    symbols,
    batchSize: 32,
    concurrency: 2,
    processBatch: async (batch, batchIndex) => {
      batchesStarted += 1;
      if (batchIndex === 1) {
        throw binanceRateLimiter.trip(418, '120', 'IP banned');
      }
      return {
        successfulCount: batch.length,
        failedCount: 0,
        skippedCount: 0,
        qualifiedCount: 0,
        newSignals: 0,
        deduplicatedSignals: 0,
      };
    },
  });

  assert.equal(summary.state, 'RATE_LIMIT_COOLDOWN');
  assert.ok(summary.skippedCount >= 32);
  assert.ok(batchesStarted < 5);
  binanceRateLimiter.reset();
});
