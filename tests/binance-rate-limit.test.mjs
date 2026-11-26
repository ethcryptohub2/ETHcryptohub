import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binanceRateLimiter,
  BinanceCooldownError,
  fetchBinanceRest,
  parseRetryAfterMs,
} from '../lib/binance-rate-limit.ts';

test('parseRetryAfterMs handles numeric seconds and HTTP dates', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs('45', now), 45_000);
  const futureDate = new Date(now + 120_000).toUTCString();
  const parsed = parseRetryAfterMs(futureDate, now);
  assert.ok(parsed !== null && parsed >= 119_000 && parsed <= 121_000);
  assert.equal(parseRetryAfterMs(null, now), null);
});

test('HTTP 418 trips circuit breaker and blocks subsequent requests without hitting fetch', async () => {
  binanceRateLimiter.reset();
  let fetchCalls = 0;
  const mockFetch = async () => {
    fetchCalls += 1;
    return new Response('IP banned', {
      status: 418,
      headers: { 'retry-after': '120', 'x-mbx-used-weight-1m': '2450' },
    });
  };

  await assert.rejects(
    () => fetchBinanceRest(mockFetch, 'https://fapi.binance.com/fapi/v1/klines', { weight: 2 }),
    (err) => err instanceof BinanceCooldownError && err.statusCode === 418,
  );
  assert.equal(fetchCalls, 1);
  assert.equal(binanceRateLimiter.getStatus().state, 'OPEN');
  assert.equal(binanceRateLimiter.getStatus().usedWeight1m, 2450);

  // Subsequent request must be blocked immediately before calling fetch
  await assert.rejects(
    () => fetchBinanceRest(mockFetch, 'https://fapi.binance.com/fapi/v1/klines', { weight: 2 }),
    (err) => err instanceof BinanceCooldownError && err.statusCode === 418,
  );
  assert.equal(fetchCalls, 1);
  binanceRateLimiter.reset();
});

test('HTTP 429 trips circuit breaker and honors Retry-After', async () => {
  binanceRateLimiter.reset();
  const now = Date.now();
  const mockFetch = async () =>
    new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': '30' },
    });

  await assert.rejects(
    () => fetchBinanceRest(mockFetch, 'https://fapi.binance.com/fapi/v1/ticker/24hr', { weight: 40, now }),
    (err) => err instanceof BinanceCooldownError && err.statusCode === 429 && err.cooldownUntil >= now + 29_000,
  );
  binanceRateLimiter.reset();
});

test('Weight budget enforces 1200/min safety cap', async () => {
  binanceRateLimiter.reset();
  const now = Date.now();
  const okFetch = async () =>
    new Response('[]', {
      status: 200,
      headers: { 'x-mbx-used-weight-1m': '1199' },
    });

  await fetchBinanceRest(okFetch, 'https://fapi.binance.com/fapi/v1/exchangeInfo', { weight: 1, now });
  assert.throws(
    () => binanceRateLimiter.assertCanRequest(5, now + 100),
    (err) => err instanceof BinanceCooldownError && err.statusCode === 429,
  );
  binanceRateLimiter.reset();
});

test('Single-flight dedupe shares one promise for concurrent identical keys', async () => {
  binanceRateLimiter.reset();
  let calls = 0;
  const work = () =>
    binanceRateLimiter.dedupe('JUPUSDT:15m', async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return [1, 2, 3];
    });

  const [a, b, c] = await Promise.all([work(), work(), work()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [1, 2, 3]);
  assert.deepEqual(c, [1, 2, 3]);
  binanceRateLimiter.reset();
});
