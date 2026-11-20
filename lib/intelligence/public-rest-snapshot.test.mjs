import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicRestSnapshot } from './public-rest-snapshot.ts';

test('public REST snapshots use one fixed GET and omit stale, unknown and invalid quotes', async () => {
  let requests = 0;
  const result = await fetchPublicRestSnapshot(AbortSignal.timeout(500), async (url, options) => {
    requests++;
    assert.equal(url, 'https://fapi.binance.com/fapi/v1/ticker/24hr');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return Response.json([
      { symbol: 'BTCUSDT', lastPrice: '100', closeTime: Date.now() },
      { symbol: 'ETHUSDT', lastPrice: '200', closeTime: Date.now() - 10_000 },
      { symbol: 'NOTALLOWED', lastPrice: '300', closeTime: Date.now() },
    ]);
  });
  assert.equal(requests, 1);
  assert.equal(result.state, 'INCOMPLETE');
  assert.deepEqual(result.quotes.map(row => [row.symbol, row.price]), [['BTCUSDT', 100]]);
});

test('public REST snapshots stop on denial and shared weight without retry', async () => {
  for (const status of [403, 418, 429, 451, 200]) {
    let requests = 0;
    const result = await fetchPublicRestSnapshot(AbortSignal.timeout(500), async () => {
      requests++;
      return new Response('[]', { status, headers: { 'x-mbx-used-weight-1m': '300' } });
    });
    assert.deepEqual(result, { state: 'UNAVAILABLE', status, quotes: [] });
    assert.equal(requests, 1);
  }
});

test('public REST snapshots reject oversized bodies and duplicate watchlist entries', async () => {
  await assert.rejects(fetchPublicRestSnapshot(AbortSignal.timeout(500),
    async () => new Response('x'.repeat(1024 * 1024 + 1))), /byte limit/);
  const quote = { symbol: 'BTCUSDT', lastPrice: '1', closeTime: Date.now() };
  await assert.rejects(fetchPublicRestSnapshot(AbortSignal.timeout(500),
    async () => Response.json([quote, quote])), /Duplicate/);
});
