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
