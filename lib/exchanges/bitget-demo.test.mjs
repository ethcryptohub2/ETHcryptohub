import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'bitget-demo.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const {
  BITGET_DEMO_CAPABILITIES,
  BITGET_DEMO_REST_URL,
  BITGET_DEMO_UNSUPPORTED_CAPABILITIES,
  BITGET_DEMO_DOCUMENTATION_URL,
  BitgetDemoError,
  createBitgetDemoAdapter,
  createBitgetDemoFixtureAdapter,
  signBitgetDemoRequest,
} = sourceModule.exports;

const credentials = {
  apiKey: 'bitget-demo-key',
  apiSecret: 'bitget-demo-secret',
  passphrase: 'bitget-demo-passphrase',
};

test('Bitget signature matches the documented HMAC-SHA256 Base64 scheme', () => {
  const timestamp = '1684814440729';
  const path = '/api/v3/account/fee-rate';
  const query = 'category=SPOT&symbol=BTCUSDT';
  const expected = crypto.createHmac('sha256', credentials.apiSecret)
    .update(`${timestamp}GET${path}?${query}`)
    .digest('base64');

  assert.equal(signBitgetDemoRequest(credentials.apiSecret, timestamp, 'GET', path, query), expected);
  assert.equal(BITGET_DEMO_REST_URL, 'https://api.bitget.com');
  assert.equal(BITGET_DEMO_DOCUMENTATION_URL, 'https://www.bitget.com/docs/uta/quick-start.md');
});

const fixtureCredentials = {
  environment: 'DEMO',
  apiKey: 'fixture-key',
  apiSecret: 'fixture-secret',
  passphrase: 'fixture-passphrase',
};
const timestamp = 1787033528294;
const category = 'USDT-FUTURES';
const instrument = {
  category, symbol: 'BTCUSDT', quoteCoin: 'USDT', type: 'perpetual', status: 'online',
  priceMultiplier: '0.02', quantityMultiplier: '0.0005',
  minOrderQty: '0.0010', maxOrderQty: '0', minOrderAmount: '5',
};
const position = {
  category, symbol: 'BTCUSDT', posSide: 'short', holdMode: 'hedge_mode', total: '0.0020',
  avgPrice: '50000', markPrice: '51000', unrealisedPnl: '-2', leverage: '2',
};
const order = {
  category, symbol: 'BTCUSDT', orderId: '12345678901234567890', clientOid: '',
  side: 'sell', orderType: 'limit', orderStatus: 'partially_filled',
  qty: '0.0020', cumExecQty: '0.0010', price: '51000',
};
const success = (data) => ({ status: 200, body: { code: '00000', data } });
const fixtureOptions = (respond) => ({ mode: 'MOCK_READY', now: () => timestamp, respond });

const entry = { symbol: order.symbol, side: 'SELL', quantity: '0.002', price: '51000', clientOrderId: 'fixtureentry1' };

function limitFixture({ ambiguous = false, holdMode = 'one_way_mode' } = {}) {
  const calls = [];
  let current;
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, {
    ...fixtureOptions(async request => {
      calls.push(request);
      if (request.path.endsWith('/order-info')) {
        return current ? success(current) : { status: 200, body: { code: '25204' } };
      }
      if (request.path.endsWith('/settings')) return success({ accountMode: 'unified', holdMode });
      if (request.path.endsWith('/instruments')) return success([{ ...instrument, maxOrderQty: '1' }]);
      if (request.path.endsWith('/cancel-order')) {
        current = { ...current, orderStatus: 'cancelled' };
        return success({ orderId: order.orderId, clientOid: entry.clientOrderId });
      }
      assert.equal(request.path, '/api/v3/trade/place-order');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.paptrading, '1');
      assert.equal(request.headers['ACCESS-SIGN'], crypto.createHmac('sha256', fixtureCredentials.apiSecret)
        .update(`${timestamp}POST${request.path}${request.body}`).digest('base64'));
      assert.deepEqual(JSON.parse(request.body), {
        category, symbol: order.symbol, side: 'sell', orderType: 'limit', timeInForce: 'gtc',
        qty: entry.quantity, price: entry.price, clientOid: entry.clientOrderId, reduceOnly: 'no',
      });
      if (ambiguous) return { status: 503, body: null };
      current = { ...order, clientOid: entry.clientOrderId };
      return success({ orderId: order.orderId, clientOid: entry.clientOrderId });
    }),
    mode: 'MOCK_LIMIT_LIFECYCLE',
  });
  return { adapter, calls };
}

test('Bitget fixture submits once, reconciles by client ID and cancels without losing fills', async () => {
  const { adapter, calls } = limitFixture();
  const submitted = await adapter.placeLimitOrder(entry);
  assert.equal(submitted.status, 'partially_filled');
  assert.deepEqual(await adapter.placeLimitOrder(entry), submitted);
  await assert.rejects(adapter.placeLimitOrder({ ...entry, price: '51000.02' }), { status: 409 });
  await adapter.cancelOrder(order.symbol, order.orderId);
  const terminal = await adapter.reconcileOrder(order.symbol, entry.clientOrderId);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.filledQuantity, order.cumExecQty);
  assert.deepEqual(calls.filter(request => request.method === 'POST').map(request => request.path), [
    '/api/v3/trade/place-order', '/api/v3/trade/cancel-order',
  ]);
});

test('Bitget fixture rejects lot, tick, notional, hedge mode and retries after ambiguous submission', async () => {
  const { adapter, calls } = limitFixture({ ambiguous: true });
  await assert.rejects(adapter.placeLimitOrder({ ...entry, quantity: '0.0021' }), { status: 422 });
  await assert.rejects(adapter.placeLimitOrder({ ...entry, price: '51000.01' }), { status: 422 });
  await assert.rejects(adapter.placeLimitOrder({ ...entry, price: '100' }), { status: 422 });
  await assert.rejects(adapter.placeLimitOrder(entry), { status: 502 });
  await assert.rejects(adapter.placeLimitOrder(entry), { status: 409 });
  assert.equal(calls.filter(request => request.method === 'POST').length, 1);
  const hedge = limitFixture({ holdMode: 'hedge_mode' });
  await assert.rejects(hedge.adapter.placeLimitOrder(entry), { status: 409 });
  assert.ok(hedge.calls.every(request => request.method === 'GET'));
  const normal = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async () => assert.fail('No I/O')));
  assert.equal(normal.placeLimitOrder, undefined);
});

test('Bitget signed fixtures normalize balances, precision, hedge positions and order status', async () => {
  const requests = [];
  const data = {
    '/api/v3/account/assets': { assets: [{ coin: 'USDT', balance: '100', available: '80', equity: '101' }] },
    '/api/v3/market/instruments': [instrument],
    '/api/v3/position/current-position': { list: [position] },
    '/api/v3/trade/order-info': order,
  };
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async (request) => {
    requests.push(request);
    return success(data[request.path]);
  }));

  await adapter.testConnection();
  assert.deepEqual(await adapter.getAccountBalance(), [
    { asset: 'USDT', walletBalance: '100', availableBalance: '80', equity: '101' },
  ]);
  const [market] = await adapter.getMarketInstruments();
  assert.equal(market.tickSize, '0.02');
  assert.equal(market.quantityStep, '0.0005');
  assert.equal(market.maximumQuantity, null);
  const [open] = await adapter.getPositions();
  assert.equal(open.side, 'SHORT');
  assert.equal(open.positionMode, 'hedge_mode');
  assert.equal(open.unrealizedPnl, '-2');
  const status = await adapter.getOrderStatus('BTCUSDT', order.orderId);
  assert.equal(status.exchangeOrderId, order.orderId);
  assert.equal(status.filledQuantity, '0.0010');
  for (const request of requests) {
    const { origin, method, path: endpoint, query, headers } = request;
    const preimage = `${timestamp}GET${endpoint}${query ? `?${query}` : ''}`;
    assert.equal(origin, 'https://api.bitget.com');
    assert.equal(method, 'GET');
    assert.equal(headers.paptrading, '1');
    assert.equal(headers['ACCESS-SIGN'], crypto.createHmac('sha256', fixtureCredentials.apiSecret)
      .update(preimage).digest('base64'));
  }
  assert.equal(adapter.capabilities.orderSubmission, false);
  assert.equal(adapter.capabilities.protection, false);
  assert.equal(adapter.placeLimitOrder, undefined);
});

test('Bitget fixture rejects live scope, real-looking credentials and unsafe identifiers before transport', async () => {
  let calls = 0;
  const options = fixtureOptions(async () => { calls += 1; return success({}); });
  assert.throws(() => createBitgetDemoFixtureAdapter({ ...fixtureCredentials, environment: 'LIVE' }, options));
  assert.throws(() => createBitgetDemoFixtureAdapter({ ...fixtureCredentials, environment: 'TESTNET' }, options));
  assert.throws(() => createBitgetDemoFixtureAdapter({ ...fixtureCredentials, apiKey: 'bg_prod' }, options));
  assert.throws(() => createBitgetDemoFixtureAdapter({ ...fixtureCredentials, passphrase: undefined }, options));
  assert.throws(() => createBitgetDemoFixtureAdapter(fixtureCredentials));
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, options);
  await assert.rejects(adapter.getOrderStatus('BTCUSDT', '1&cancel=1'), /invalid/i);
  assert.equal(calls, 0);
});

test('Bitget fixture fails closed on denial, throttling, ambiguity and wrong contract scope', async () => {
  for (const [response, status] of [
    [{ status: 429, body: {} }, 429],
    [{ status: 302, body: {} }, 502],
    [{ status: 200, body: { code: '40012', msg: fixtureCredentials.apiSecret } }, 502],
    [success({ ...order, orderId: '9' }), 502],
    [success({ ...order, category: 'SPOT' }), 502],
  ]) {
    let calls = 0;
    const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async () => {
      calls += 1;
      return response;
    }));
    await assert.rejects(adapter.getOrderStatus('BTCUSDT', order.orderId), (error) =>
      error.status === status && !error.message.includes(fixtureCredentials.apiSecret));
    assert.equal(calls, 1);
  }

  const interrupted = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async () => {
    throw new Error(fixtureCredentials.apiSecret);
  }));
  await assert.rejects(interrupted.testConnection(), { message: 'Bitget fixture transport failed.' });
});

test('Bitget fixture reconciles only the exact client ID with a signed and encoded lookup', async () => {
  const clientOid = 'BOT#1:case +2';
  const requests = [];
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async (request) => {
    requests.push(request);
    return success({ ...order, clientOid });
  }));
  const actual = await adapter.reconcileOrder('BTCUSDT', clientOid);
  assert.equal(actual.clientOrderId, clientOid);
  assert.equal(actual.exchangeOrderId, order.orderId);
  assert.equal(adapter.capabilities.reconciliation, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query, 'clientOid=BOT%231%3Acase+%2B2');
  assert.equal(requests[0].headers['ACCESS-SIGN'], crypto.createHmac('sha256', fixtureCredentials.apiSecret)
    .update(`${timestamp}GET/api/v3/trade/order-info?${requests[0].query}`).digest('base64'));
  await assert.rejects(adapter.reconcileOrder('BTCUSDT', 'entry&orderId=123'), { status: 400 });
  assert.equal(requests.length, 1);
});

test('Bitget not-found stays unresolved, and denials and mismatched order IDs never become absence', async () => {
  let calls = 0;
  const outcomes = [
    { status: 200, body: { code: '25204' } },
    { status: 200, body: { code: '40012' } },
    success({ ...order, clientOid: 'other' }),
  ];
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async () => {
    calls++;
    return outcomes.shift();
  }));
  assert.equal(await adapter.reconcileOrder('BTCUSDT', 'entry-123'), null);
  await assert.rejects(adapter.reconcileOrder('BTCUSDT', 'entry-123'), { status: 502 });
  await assert.rejects(adapter.reconcileOrder('BTCUSDT', 'entry-123'), { status: 502 });
  assert.equal(calls, 3);
});

test('Bitget remote adapter stays blocked in every environment and makes no requests', () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    throw new Error('Bitget test must not make network requests.');
  };
  try {
    assert.ok(BITGET_DEMO_UNSUPPORTED_CAPABILITIES.includes('connectionTest'));
    assert.ok(Object.values(BITGET_DEMO_CAPABILITIES).every((enabled) => !enabled));
    for (const environment of ['DEMO', 'TESTNET', 'LIVE']) {
      assert.throws(
        () => createBitgetDemoAdapter(environment),
        (error) => error instanceof BitgetDemoError && /No requests are enabled/.test(error.message),
      );
    }
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Bitget fixture signs one cancellation and confirms terminal status with retained fills', async () => {
  const requests = [];
  const clientOid = 'fixture-order';
  const open = { ...order, clientOid };
  const terminal = { ...open, orderStatus: 'cancelled', cumExecQty: '0.0015' };
  const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async (request) => {
    requests.push(request);
    if (request.method === 'POST') return success({ orderId: order.orderId, clientOid });
    return success(requests.length === 1 ? open : terminal);
  }));

  await adapter.cancelOrder(order.symbol, order.orderId);
  await adapter.cancelOrder(order.symbol, order.orderId);
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'POST', 'GET', 'GET']);
  const { path, headers, query, body } = requests[1];
  assert.equal(path, '/api/v3/trade/cancel-order');
  assert.equal(query, '');
  assert.deepEqual(JSON.parse(body), { orderId: order.orderId, category });
  assert.equal(headers.paptrading, '1');
  assert.equal(headers['ACCESS-SIGN'], crypto.createHmac('sha256', fixtureCredentials.apiSecret)
    .update(`${timestamp}POST${path}${body}`).digest('base64'));
});

test('Bitget fixture requires reconciliation after a mismatched acknowledgment or regressed fill', async () => {
  for (const mismatch of ['acknowledgment', 'fill']) {
    let posts = 0;
    let gets = 0;
    const adapter = createBitgetDemoFixtureAdapter(fixtureCredentials, fixtureOptions(async (request) => {
      if (request.method === 'POST') {
        posts++;
        return success({ orderId: mismatch === 'acknowledgment' ? '900' : order.orderId, clientOid: '' });
      }
      gets++;
      return success(mismatch === 'fill' && gets === 2
        ? { ...order, orderStatus: 'cancelled', cumExecQty: '0.0009' }
        : order);
    }));
    await assert.rejects(adapter.cancelOrder(order.symbol, order.orderId), /reconcile/i);
    await assert.rejects(adapter.cancelOrder(order.symbol, order.orderId), /already attempted/i);
    assert.equal(posts, 1);
  }
});
