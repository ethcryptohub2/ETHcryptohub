import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RollingCandleCache,
  MINIMUM_INDICATOR_WARMUP,
  detectCandleGaps,
  timeframeToMs,
} from '../lib/candle-cache.ts';
import { partitionStreams, parseBinanceKlineEvent } from '../lib/ws-kline-engine.ts';

function buildCandles(count, intervalMs, endOpenTime) {
  const start = endOpenTime - (count - 1) * intervalMs;
  return Array.from({ length: count }, (_, i) => {
    const openTime = start + i * intervalMs;
    return {
      openTime,
      high: 105,
      low: 95,
      close: 100 + (i % 5),
      volume: 1000,
      closeTime: openTime + intervalMs - 1,
    };
  });
}

test('RollingCandleCache retains 210+ warm-up history and supports incremental closed-candle updates', () => {
  const cache = new RollingCandleCache();
  const intervalMs = timeframeToMs('15m');
  const now = 1_795_700_000_000;
  const alignedOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const history = buildCandles(250, intervalMs, alignedOpen);

  cache.setHistory('BINANCE', 'BTCUSDT', '15m', history, now);
  const initial = cache.assess('BINANCE', 'BTCUSDT', '15m', now, false);
  assert.equal(initial.status, 'FRESH_LIVE');
  assert.ok(initial.candles.length >= MINIMUM_INDICATOR_WARMUP);
  assert.equal(initial.hasGaps, false);

  // Incremental closed candle
  const nextOpen = alignedOpen + intervalMs;
  const updated = cache.upsertClosedCandle(
    'BINANCE',
    'BTCUSDT',
    '15m',
    { openTime: nextOpen, high: 108, low: 99, close: 106, volume: 1500, closeTime: nextOpen + intervalMs - 1 },
    nextOpen + intervalMs,
  );
  assert.equal(updated, true);

  const afterWs = cache.assess('BINANCE', 'BTCUSDT', '15m', nextOpen + intervalMs, false);
  assert.equal(afterWs.status, 'FRESH_LIVE');
  assert.equal(afterWs.source, 'WS_INCREMENTAL');
  assert.equal(afterWs.candles.at(-1).close, 106);

  // Out-of-order older candle must be rejected
  const staleInsert = cache.upsertClosedCandle(
    'BINANCE',
    'BTCUSDT',
    '15m',
    { openTime: alignedOpen - intervalMs, high: 100, low: 90, close: 95, volume: 100, closeTime: alignedOpen - 1 },
    nextOpen + intervalMs,
  );
  assert.equal(staleInsert, false);
});

test('RollingCandleCache detects gaps and marks stale data as STALE', () => {
  const cache = new RollingCandleCache();
  const intervalMs = timeframeToMs('15m');
  const now = 1_795_700_000_000;
  const alignedOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const history = buildCandles(220, intervalMs, alignedOpen);
  // Remove candle near the end to introduce a 2x interval gap
  history.splice(210, 1);
  assert.equal(detectCandleGaps(history, intervalMs), true);

  cache.setHistory('BINANCE', 'ETHUSDT', '15m', history, now);
  const assessed = cache.assess('BINANCE', 'ETHUSDT', '15m', now, false);
  assert.equal(assessed.status, 'STALE');
  assert.equal(assessed.hasGaps, true);
});

test('RollingCandleCache distinguishes MISSING vs COOLDOWN', () => {
  const cache = new RollingCandleCache();
  assert.equal(cache.assess('BINANCE', 'SOLUSDT', '15m', Date.now(), false).status, 'MISSING');
  assert.equal(cache.assess('BINANCE', 'SOLUSDT', '15m', Date.now(), true).status, 'COOLDOWN');
});

test('WS kline engine partitions streams <= 180 per connection and parses closed candles', () => {
  const symbols = Array.from({ length: 400 }, (_, i) => `SYM${i}USDT`);
  const partitions = partitionStreams(symbols, '15m');
  assert.equal(partitions.length, 3);
  assert.equal(partitions[0].length, 180);
  assert.equal(partitions[1].length, 180);
  assert.equal(partitions[2].length, 40);

  const parsed = parseBinanceKlineEvent({
    stream: 'btcusdt@kline_15m',
    data: {
      e: 'kline',
      s: 'BTCUSDT',
      k: { t: 1700000000000, T: 1700000899999, i: '15m', o: '95000', h: '95500', l: '94900', c: '95200', v: '123.4', x: true },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.symbol, 'BTCUSDT');
  assert.equal(parsed.isClosed, true);
  assert.equal(parsed.candle.close, 95200);
});
