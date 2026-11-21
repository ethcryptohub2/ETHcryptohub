import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireAlphaSnapshot, alphaMaxRequests, disabledAlphaSnapshot } from './alpha-intelligence.ts';

const ms = 86_400_000;
const now = Date.parse('2026-11-21T12:00:00Z');
const midnight = Date.parse('2026-11-21T00:00:00Z');
const tokens = [
  { alphaId: 'ALPHA_101', chainName: 'BSC', contractAddress: '0x1234', name: 'Fixture A', symbol: 'FA' },
  { alphaId: 'ALPHA_102', chainName: 'Solana', contractAddress: 'fixture123', name: 'Fixture B', symbol: 'FB' },
];
const markets = {
  symbols: [
    { symbol: 'ALPHA_101USDC', status: 'TRADING', baseAsset: 'ALPHA_101', quoteAsset: 'USDC' },
    { symbol: 'ALPHA_101USDT', status: 'TRADING', baseAsset: 'ALPHA_101', quoteAsset: 'USDT' },
    { symbol: 'ALPHA_102USDC', status: 'TRADING', baseAsset: 'ALPHA_102', quoteAsset: 'USDC' },
    { symbol: 'ALPHA_102USDT', status: 'BREAK', baseAsset: 'ALPHA_102', quoteAsset: 'USDT' },
  ],
};
const ticker = { lastPrice: '2', quoteVolume: '4000', priceChangePercent: '-3.5', closeTime: now - 5000 };
const depth = { lastUpdateId: 22, E: now - 1000, bids: [['1.5', '3'], ['1.25', '2']], asks: [['2.5', '4']] };
const candle = (open, amount) => [String(open), '1', '1', '1', '1', '1', String(open + ms - 1), amount, 1, '1', '1', '0'];
const envelope = data => Response.json({ code: '000000', success: true, data });
const options = { approved: true, tokenIds: ['ALPHA_101', 'ALPHA_102'], now: () => now };
function transportFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    transport: async (url, init) => {
      assert.equal(url.origin, 'https://www.binance.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(init.headers, { accept: 'application/json' });
      assert.ok(init.signal instanceof AbortSignal);
      const method = url.pathname.split('/').at(-1);
      calls.push(method);
      if (overrides[method]) return overrides[method](url);
      const symbol = url.searchParams.get('symbol');
      if (method === 'list') return envelope(tokens);
      if (method === 'get-exchange-info') return envelope(markets);
      assert.match(symbol, /^ALPHA_10[12]USD[TC]$/);
      if (method === 'ticker') return envelope({ symbol, ...ticker });
      if (method === 'fullDepth') {
        assert.equal(url.searchParams.get('limit'), '5');
        return envelope({ symbol, ...depth });
      }
      assert.equal(method, 'klines');
      assert.equal(url.searchParams.get('limit'), '3');
      assert.equal(url.searchParams.get('interval'), '1d');
      return envelope([candle(midnight - 2 * ms, '200'), candle(midnight - ms, '300'), candle(midnight, '900')]);
    },
  };
}

test('disabled Alpha source issues zero requests and contains no example records or scores', async () => {
  const fixture = transportFixture();
  const snapshot = await acquireAlphaSnapshot({ ...options, approved: false, transport: fixture.transport });
  assert.deepEqual(snapshot, disabledAlphaSnapshot());
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.checkedAt, null);
  assert.equal(fixture.calls.length, 0);
});

test('Alpha discovery matches supported markets and derives only validated market observations', async () => {
  const fixture = transportFixture();
  const snapshot = await acquireAlphaSnapshot({ ...options, transport: fixture.transport });
  assert.equal(fixture.calls.length, alphaMaxRequests);
  assert.deepEqual(snapshot.rows.map(row => row.market), ['ALPHA_101USDT', 'ALPHA_102USDC']);
  const row = snapshot.rows[0];
  assert.equal(row.price, 2);
  assert.equal(row.momentumPercent, -3.5);
  assert.equal(row.volumeChangePercent, 50);
  assert.equal(row.bidDepthQuote, 7);
  assert.equal(row.askDepthQuote, 10);
  assert.equal(row.liquidity, 'VERIFIED_DEPTH');
  assert.equal(row.verifiedAt, new Date(ticker.closeTime).toISOString());
  assert.equal(row.signalStatus, 'OBSERVATION_ONLY');
  for (const field of ['flows', 'holderConcentration', 'contractRisk', 'riskScore', 'sentiment', 'campaigns', 'xActivity', 'youtubeActivity', 'engagementAnomaly']) {
    assert.equal(row[field], null);
    assert.equal(snapshot.sources.find(source => source.id === 'risk').status, 'UNAVAILABLE');
  }
});

test('provider denial, bad body and stale ticker stop the batch without retry or fallback', async () => {
  for (const response of [
    () => new Response(null, { status: 451 }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    url => envelope({ ...ticker, symbol: url.searchParams.get('symbol'), closeTime: now - 61_000 }),
  ]) {
    const fixture = transportFixture({ ticker: response });
    const snapshot = await acquireAlphaSnapshot({ ...options, transport: fixture.transport });
    assert.deepEqual(fixture.calls, ['list', 'get-exchange-info', 'ticker']);
    assert.equal(snapshot.rows[0].market, 'ALPHA_101USDT');
    assert.equal(snapshot.rows[0].price, null);
    assert.equal(snapshot.rows[0].liquidity, 'UNAVAILABLE');
    assert.equal(snapshot.sources.find(source => source.id === 'ticker').status, 'UNAVAILABLE');
  }
});

test('crossed order book preserves verified ticker and withholds depth and later data', async () => {
  const fixture = transportFixture({
    fullDepth: url => envelope({ ...depth, symbol: url.searchParams.get('symbol'), bids: [['9', '1']] }),
  });
  const snapshot = await acquireAlphaSnapshot({ ...options, transport: fixture.transport });
  assert.deepEqual(fixture.calls, ['list', 'get-exchange-info', 'ticker', 'fullDepth']);
  assert.equal(snapshot.rows[0].price, 2);
  assert.equal(snapshot.rows[0].bidDepthQuote, null);
  assert.equal(snapshot.rows[0].volumeChangePercent, null);
});

test('rejects unbounded or invalid token requests before transport', async () => {
  const fixture = transportFixture();
  for (const tokenIds of [['ALPHA_101', 'ALPHA_102', 'ALPHA_103'], ['ALPHA_101', 'ALPHA_101'], ['https://example.test']]) {
    await assert.rejects(acquireAlphaSnapshot({ ...options, tokenIds, transport: fixture.transport }));
  }
  assert.equal(fixture.calls.length, 0);
});
