import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'okx-demo.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
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
  createOkxDemoAdapter,
  OkxDemoError,
  OKX_DEMO_CAPABILITIES,
  signOkxDemoRequest,
} = sourceModule.exports;

const credentials = {
  apiKey: 'demo-api-key-1234',
  apiSecret: 'demo-secret-5678',
  passphrase: 'demo-passphrase',
};
const envelope = (data = [], code = '0', msg = '') => ({ code, msg, data });

function installFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  return {
    calls,
    restore() { global.fetch = original; },
  };
}

function assertPrivateDemoRequest(url, init, account = credentials) {
  assert.equal(url.origin, 'https://openapi.okx.com');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-simulated-trading'], '1');
  assert.equal(init.headers['OK-ACCESS-KEY'], account.apiKey);
  assert.equal(init.headers['OK-ACCESS-PASSPHRASE'], account.passphrase);
  const timestamp = init.headers['OK-ACCESS-TIMESTAMP'];
  assert.match(timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const requestPath = `${url.pathname}${url.search}`;
  const expected = crypto.createHmac('sha256', account.apiSecret)
    .update(`${timestamp}${init.method}${requestPath}${init.body ?? ''}`)
    .digest('base64');
  assert.equal(init.headers['OK-ACCESS-SIGN'], expected);
}

test('signs the exact OKX V5 timestamp, method, path, body with HMAC-SHA256 Base64', () => {
  const timestamp = '2026-11-18T00:00:00.123Z';
  const requestPath = '/api/v5/account/balance?ccy=BTC%2CUSDT';
  const expected = crypto.createHmac('sha256', credentials.apiSecret)
    .update(`${timestamp}GET${requestPath}`)
    .digest('base64');
  assert.equal(
    signOkxDemoRequest(credentials.apiSecret, timestamp, 'GET', requestPath),
    expected,
  );
  assert.match(expected, /^[A-Za-z0-9+/]+=*$/);
});

test('connection and authenticated account reads use the signed Demo host and header', async () => {
  const mock = installFetch((url, init) => {
    assertPrivateDemoRequest(url, init);
    if (url.pathname === '/api/v5/account/config') {
      return Response.json(envelope([{ acctLv: '2', posMode: 'net_mode' }]));
    }
    if (url.pathname === '/api/v5/account/balance') {
      return Response.json(envelope([{
        details: [{
          ccy: 'USDT', cashBal: '100.25', availBal: '90.10', eq: '101.50', upl: '1.25',
        }],
      }]));
    }
    if (url.pathname === '/api/v5/account/positions') {
      assert.equal(url.searchParams.get('instType'), 'SWAP');
      return Response.json(envelope([{
        instId: 'BTC-USDT-SWAP', instType: 'SWAP', pos: '-2.50', posSide: 'net',
        avgPx: '65000', markPx: '64000', upl: '-2.5', lever: '5',
      }]));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const adapter = createOkxDemoAdapter(credentials);
    await adapter.testConnection();
    assert.deepEqual(await adapter.getAccountConfiguration(), {
      accountLevel: 'futures',
      positionMode: 'net_mode',
    });
    assert.deepEqual(await adapter.getAccountBalance(), [{
      asset: 'USDT',
      walletBalance: '100.25',
      availableBalance: '90.10',
      equity: '101.50',
      unrealizedPnl: '1.25',
    }]);
    assert.deepEqual(await adapter.getPositions(), [{
      symbol: 'BTC-USDT-SWAP',
      side: 'SHORT',
      quantity: '2.5',
      entryPrice: '65000',
      markPrice: '64000',
      unrealizedPnl: '-2.5',
      leverage: 5,
    }]);
    assert.equal(mock.calls.length, 5);
    assert.ok(mock.calls.every(({ url }) => url.origin === 'https://openapi.okx.com'));
  } finally {
    mock.restore();
  }
});

test('maps all documented account levels and reports long/short position mode', async () => {
  for (const [acctLv, accountLevel] of [
    ['1', 'spot'],
    ['2', 'futures'],
    ['3', 'multi-currency-margin'],
    ['4', 'portfolio-margin'],
  ]) {
    const mock = installFetch((url, init) => {
      assertPrivateDemoRequest(url, init);
      return Response.json(envelope([{ acctLv, posMode: 'long_short_mode' }]));
    });
    try {
      assert.deepEqual(await createOkxDemoAdapter(credentials).getAccountConfiguration(), {
        accountLevel,
        positionMode: 'long_short_mode',
      });
    } finally {
      mock.restore();
    }
  }
});

test('normalizes linear SWAP contract sizing and lot-step filters without floating point math', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://openapi.okx.com');
    assert.equal(url.pathname, '/api/v5/public/instruments');
    assert.equal(url.searchParams.get('instType'), 'SWAP');
    assert.equal(init.headers['x-simulated-trading'], '1');
    return Response.json(envelope([
      {
        instId: 'BTC-USDT-SWAP', instType: 'SWAP', state: 'live', settleCcy: 'USDT',
        ctType: 'linear', ctVal: '0.0100', ctMult: '1.50', tickSz: '0.1',
        lotSz: '0.1', minSz: '1.0', maxLmtSz: '100', lever: '125',
      },
      {
        instId: 'BTC-USD-SWAP', instType: 'SWAP', state: 'live', settleCcy: 'BTC',
        ctType: 'inverse', ctVal: '100', ctMult: '1', tickSz: '0.1',
        lotSz: '1', minSz: '1', maxLmtSz: '100', lever: '20',
      },
      {
        instId: 'ETH-USDT-SWAP', instType: 'SWAP', state: 'live', settleCcy: 'USDT',
        ctType: 'linear', ctVal: '10', ctMult: '1', tickSz: '0.1',
        lotSz: '1', minSz: '1', maxLmtSz: '100', lever: '50',
      },
    ]));
  });
  try {
    assert.deepEqual(await createOkxDemoAdapter(credentials).getMarketInstruments(), [
      {
        exchangeSymbol: 'BTC-USDT-SWAP',
        smartExitSymbol: 'BTC-USDT-SWAP',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        status: 'live',
        tickSize: '0.1',
        quantityStep: '0.1',
        minimumQuantity: '1',
        maximumQuantity: '100',
        minimumNotional: null,
        contractSize: '0.015',
        maximumLeverage: 125,
      },
      {
        exchangeSymbol: 'ETH-USDT-SWAP',
        smartExitSymbol: 'ETH-USDT-SWAP',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        status: 'live',
        tickSize: '0.1',
        quantityStep: '1',
        minimumQuantity: '1',
        maximumQuantity: '100',
        minimumNotional: null,
        contractSize: '10',
        maximumLeverage: 50,
      },
    ]);
  } finally {
    mock.restore();
  }
});

test('rejects invalid SWAP contract metadata instead of exposing unsafe sizing', async () => {
  const mock = installFetch(() => Response.json(envelope([{
    instId: 'ETH-USDT-SWAP', instType: 'SWAP', state: 'live', settleCcy: 'USDT',
    ctType: 'linear', ctVal: '0.1', ctMult: '1', tickSz: '0.01',
    lotSz: '0.3', minSz: '0.5', maxLmtSz: '100', lever: '50',
  }])));
  try {
    await assert.rejects(
      createOkxDemoAdapter(credentials).getMarketInstruments(),
      (error) => error instanceof OkxDemoError && error.status === 502 &&
        error.message.includes('contract sizing or lot-step'),
    );
  } finally {
    mock.restore();
  }
});

test('does not normalize positions or make a positions request in hedge mode', async () => {
  const mock = installFetch((url, init) => {
    assertPrivateDemoRequest(url, init);
    assert.equal(url.pathname, '/api/v5/account/config');
    return Response.json(envelope([{ acctLv: '2', posMode: 'long_short_mode' }]));
  });
  try {
    await assert.rejects(
      createOkxDemoAdapter(credentials).getPositions(),
      (error) => error instanceof OkxDemoError && error.status === 409,
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('rejects incomplete credentials before networking', async () => {
  let calls = 0;
  const original = global.fetch;
  global.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
  try {
    assert.throws(
      () => createOkxDemoAdapter({ apiKey: credentials.apiKey, apiSecret: credentials.apiSecret }),
      (error) => error instanceof OkxDemoError && error.status === 422 &&
        error.message.includes('API passphrase'),
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = original;
  }
});

test('keeps network failures on the fixed Demo host with no fallback or retry', async () => {
  const mock = installFetch((url, init) => {
    assertPrivateDemoRequest(url, init);
    throw new TypeError('connection reset');
  });
  try {
    await assert.rejects(
      createOkxDemoAdapter(credentials).testConnection(),
      (error) => error instanceof OkxDemoError && error.status === 503,
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url.origin, 'https://openapi.okx.com');
  } finally {
    mock.restore();
  }
});

test('keeps unsupported order and protection lifecycles disabled and rejects before networking', async () => {
  assert.deepEqual(OKX_DEMO_CAPABILITIES, {
    connectionTest: true,
    balance: true,
    instruments: true,
    positions: true,
    entryPreflight: false,
    marketEntry: false,
    limitEntry: false,
    stopLossProtection: false,
    takeProfitProtection: false,
    trailingProtection: false,
    reduceOnlyClose: false,
    reconciliation: false,
    adminLifecycle: false,
  });
  let calls = 0;
  const original = global.fetch;
  global.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
  try {
    const adapter = createOkxDemoAdapter(credentials);
    const operations = [
      () => adapter.placeMarketOrder({
        symbol: 'BTC-USDT-SWAP', side: 'BUY', quantity: '1', clientOrderId: 'entry-1',
      }),
      () => adapter.placeLimitOrder({
        symbol: 'BTC-USDT-SWAP', side: 'BUY', quantity: '1', price: '1',
        clientOrderId: 'entry-2',
      }),
      () => adapter.setPositionStopLoss('BTC-USDT-SWAP', '1'),
      () => adapter.setPositionTakeProfit('BTC-USDT-SWAP', '2'),
      () => adapter.closePosition('BTC-USDT-SWAP'),
      () => adapter.cancelOrder('BTC-USDT-SWAP', 'order-1'),
      () => adapter.reconcileOrder('BTC-USDT-SWAP', 'entry-1'),
    ];
    for (const operation of operations) {
      await assert.rejects(
        operation(),
        (error) => error instanceof OkxDemoError && error.status === 501 &&
          error.message.includes('TP1/TP2 trailing and TP3 full-position lifecycle'),
      );
    }
    assert.equal(calls, 0);
  } finally {
    global.fetch = original;
  }
});

const swapOrder = {
  instType: 'SWAP', instId: 'BTC-USDT-SWAP', ordId: '1753197687182819328', clOrdId: 'entry1',
  side: 'buy', ordType: 'limit', state: 'partially_filled', sz: '0.400', accFillSz: '0.125', px: '50000.10',
};

test('OKX signed status and reconciliation match the requested swap and identifier', async () => {
  const calls = [];
  const transport = async (input, init) => {
    const url = new URL(input);
    assertPrivateDemoRequest(url, init);
    assert.equal(init.method, 'GET');
    assert.equal(url.pathname, '/api/v5/trade/order');
    assert.equal(url.searchParams.get('instId'), swapOrder.instId);
    calls.push(url.searchParams);
    return Response.json(envelope([swapOrder]));
  };
  const adapter = createOkxDemoAdapter(credentials, transport);
  const order = await adapter.getOrderStatus(swapOrder.instId, swapOrder.ordId);
  assert.deepEqual(order, {
    symbol: swapOrder.instId, exchangeOrderId: swapOrder.ordId, clientOrderId: swapOrder.clOrdId,
    side: 'BUY', type: 'LIMIT', status: 'PARTIALLY_FILLED', quantity: '0.400', filledQuantity: '0.125',
    price: '50000.10',
  });
  assert.deepEqual(await adapter.reconcileOrder(swapOrder.instId, swapOrder.clOrdId), order);
  assert.equal(calls[0].get('ordId'), swapOrder.ordId);
  assert.equal(calls[0].has('clOrdId'), false);
  assert.equal(calls[1].get('clOrdId'), swapOrder.clOrdId);
  assert.equal(calls[1].has('ordId'), false);
});

test('OKX lookup rejects invalid scope, unknown responses and transport failures without retries', async () => {
  let calls = 0;
  const responses = [
    Response.json(envelope([], '51603')),
    Response.json(envelope([], '50011')),
    Response.json(envelope([], '50101')),
    Response.json(envelope([])),
    Response.json(envelope([{ ...swapOrder, clOrdId: 'wrong' }])),
    Response.json(envelope([{ ...swapOrder, state: 'filled' }])),
    new Response(null, { status: 302, headers: { location: 'https://www.okx.com' } }),
  ];
  const adapter = createOkxDemoAdapter(credentials, async () => {
    calls++;
    const response = responses.shift();
    if (!response) throw new TypeError('connection timed out');
    return response;
  });
  await assert.rejects(adapter.getOrderStatus('BTC-USDT', swapOrder.ordId), { status: 422 });
  await assert.rejects(adapter.reconcileOrder(swapOrder.instId, '1&ordId=2'), { status: 422 });
  assert.equal(calls, 0);
  assert.equal(await adapter.reconcileOrder(swapOrder.instId, swapOrder.clOrdId), null);
  for (const status of [429, 502, 502, 502, 502, 502, 503]) {
    await assert.rejects(adapter.reconcileOrder(swapOrder.instId, swapOrder.clOrdId), { status });
  }
  assert.equal(calls, 8);
});

const cancellationCredentials = {
  apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-passphrase',
};
const cancellationAck = envelope([{ ordId: swapOrder.ordId, clOrdId: swapOrder.clOrdId, sCode: '0' }]);

const limitFixtureInput = {
  symbol: swapOrder.instId, side: 'BUY', quantity: '0.4', price: '50000.1', clientOrderId: swapOrder.clOrdId,
};

function createLimitFixture({ ambiguous = false, positionMode = 'net_mode' } = {}) {
  let order;
  const calls = [];
  const transport = async (input, init) => {
    const url = new URL(input);
    calls.push([init.method, url.pathname]);
    if (url.pathname === '/api/v5/public/instruments') {
      assert.equal(url.searchParams.get('instType'), 'SWAP');
      return Response.json(envelope([{
        instId: swapOrder.instId, instType: 'SWAP', state: 'live', settleCcy: 'USDT',
        ctType: 'linear', ctVal: '0.01', ctMult: '1', tickSz: '0.1', lotSz: '0.1', minSz: '0.1', maxLmtSz: '10',
      }]));
    }
    assertPrivateDemoRequest(url, init, cancellationCredentials);
    if (url.pathname === '/api/v5/account/config') {
      return Response.json(envelope([{ acctLv: '2', posMode: positionMode }]));
    }
    if (init.method === 'GET') {
      assert.equal(url.pathname, '/api/v5/trade/order');
      return Response.json(order ? envelope([order]) : envelope([], '51603'));
    }
    if (url.pathname === '/api/v5/trade/cancel-order') {
      order = { ...order, state: 'canceled' };
      return Response.json(cancellationAck);
    }
    assert.equal(url.pathname, '/api/v5/trade/order');
    assert.deepEqual(JSON.parse(init.body), {
      instId: swapOrder.instId, tdMode: 'cross', posSide: 'net', side: 'buy',
      ordType: 'limit', px: '50000.1', sz: '0.4', clOrdId: swapOrder.clOrdId,
    });
    if (ambiguous) return new Response(null, { status: 503 });
    order = swapOrder;
    return Response.json(cancellationAck);
  };
  return { calls, adapter: createOkxDemoAdapter(cancellationCredentials, transport, 'MOCK_LIMIT_LIFECYCLE') };
}

test('OKX fixture submits one limit order, reconciles replay by client ID and cancels without erasing fills', async () => {
  const { adapter, calls } = createLimitFixture();
  const order = await adapter.placeLimitOrder(limitFixtureInput);
  assert.equal(order.status, 'PARTIALLY_FILLED');
  assert.deepEqual(await adapter.placeLimitOrder(limitFixtureInput), order);
  await assert.rejects(adapter.placeLimitOrder({ ...limitFixtureInput, price: '50000.2' }), { status: 409 });
  await adapter.cancelOrder(order.symbol, order.exchangeOrderId);
  const terminal = await adapter.reconcileOrder(order.symbol, limitFixtureInput.clientOrderId);
  assert.equal(terminal.status, 'CANCELED');
  assert.equal(terminal.filledQuantity, swapOrder.accFillSz);
  assert.deepEqual(calls.filter(([method]) => method === 'POST'), [
    ['POST', '/api/v5/trade/order'], ['POST', '/api/v5/trade/cancel-order'],
  ]);
  assert.equal(adapter.capabilities.adminLifecycle, false);
});

test('OKX fixture suppresses ambiguous limit-entry retries and rejects invalid lot/tick and position mode', async () => {
  const { adapter, calls } = createLimitFixture({ ambiguous: true });
  await assert.rejects(adapter.placeLimitOrder({ ...limitFixtureInput, quantity: '0.41' }), { status: 422 });
  await assert.rejects(adapter.placeLimitOrder({ ...limitFixtureInput, price: '50000.11' }), { status: 422 });
  await assert.rejects(adapter.placeLimitOrder(limitFixtureInput), { status: 502 });
  await assert.rejects(adapter.placeLimitOrder(limitFixtureInput), { status: 409 });
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  const hedge = createLimitFixture({ positionMode: 'long_short_mode' });
  await assert.rejects(hedge.adapter.placeLimitOrder(limitFixtureInput), { status: 409 });
  assert.ok(hedge.calls.every(([method]) => method === 'GET'));
  const blocked = async () => assert.fail('fixture POST must not run');
  assert.throws(() => createOkxDemoAdapter(credentials, blocked, 'MOCK_LIMIT_LIFECYCLE'), { status: 422 });
  await assert.rejects(createOkxDemoAdapter(cancellationCredentials, blocked)
    .placeLimitOrder(limitFixtureInput), { status: 501 });
});

test('OKX fixture cancellation signs one exact POST and independently confirms the terminal order', async () => {
  const calls = [];
  let state = 'partially_filled';
  const transport = async (input, init) => {
    const url = new URL(input);
    assertPrivateDemoRequest(url, init, cancellationCredentials);
    calls.push([init.method, url.pathname]);
    if (init.method === 'POST') {
      assert.equal(url.search, '');
      assert.deepEqual(JSON.parse(init.body), { instId: swapOrder.instId, ordId: swapOrder.ordId });
      state = 'canceled';
      return Response.json(cancellationAck);
    }
    return Response.json(envelope([{ ...swapOrder, state }]));
  };
  const adapter = createOkxDemoAdapter(cancellationCredentials, transport, 'MOCK_CANCELLATION');
  await adapter.cancelOrder(swapOrder.instId, swapOrder.ordId);
  await adapter.cancelOrder(swapOrder.instId, swapOrder.ordId);
  assert.deepEqual(calls, [
    ['GET', '/api/v5/trade/order'],
    ['POST', '/api/v5/trade/cancel-order'],
    ['GET', '/api/v5/trade/order'],
    ['GET', '/api/v5/trade/order'],
  ]);
  const order = await adapter.getOrderStatus(swapOrder.instId, swapOrder.ordId);
  assert.equal(order.status, 'CANCELED');
  assert.equal(order.filledQuantity, swapOrder.accFillSz);
  assert.equal(adapter.capabilities.adminLifecycle, false);
});

test('OKX rejects real-looking credentials and never retries failed, ambiguous or mismatched cancellation', async () => {
  const unused = async () => assert.fail('must not request');
  assert.throws(() => createOkxDemoAdapter(credentials, unused, 'MOCK_CANCELLATION'), { status: 422 });
  assert.throws(() => createOkxDemoAdapter(cancellationCredentials, fetch, 'MOCK_CANCELLATION'), { status: 422 });
  await assert.rejects(createOkxDemoAdapter(cancellationCredentials, unused)
    .cancelOrder(swapOrder.instId, swapOrder.ordId), { status: 501 });

  for (const postResponse of [
    () => { throw new Error('transport timeout'); },
    () => Response.json(cancellationAck), // Accepted, but the order remains open.
    () => Response.json(envelope([{ ordId: '999', clOrdId: swapOrder.clOrdId, sCode: '0' }])),
    () => Response.json(envelope([{ ordId: swapOrder.ordId, clOrdId: swapOrder.clOrdId, sCode: '51401' }])),
  ]) {
    let posts = 0;
    const adapter = createOkxDemoAdapter(cancellationCredentials, async (_, init) => {
      if (init.method === 'GET') return Response.json(envelope([swapOrder]));
      posts++;
      return postResponse();
    }, 'MOCK_CANCELLATION');
    await assert.rejects(adapter.cancelOrder(swapOrder.instId, swapOrder.ordId), /Reconcile the original order/);
    await assert.rejects(adapter.cancelOrder(swapOrder.instId, swapOrder.ordId), /already attempted cancellation/);
    assert.equal(posts, 1);
  }
});

test('OKX fixture cancellation rejects a wrong contract, ID, or missing order before submitting', async () => {
  const methods = [];
  const adapter = createOkxDemoAdapter(cancellationCredentials, async (_, init) => {
    methods.push(init.method);
    return Response.json(envelope([], '51603'));
  }, 'MOCK_CANCELLATION');
  await assert.rejects(adapter.cancelOrder('BTC-USDT', swapOrder.ordId), { status: 422 });
  await assert.rejects(adapter.cancelOrder(swapOrder.instId, '1&ordId=2'), { status: 422 });
  await assert.rejects(adapter.cancelOrder(swapOrder.instId, swapOrder.ordId), { status: 409 });
  assert.deepEqual(methods, ['GET']);
});

test('OKX concurrent fixture cancellation sends one mutation and rejects regressed fill evidence', async () => {
  let posts = 0;
  const adapter = createOkxDemoAdapter(cancellationCredentials, async (_, init) => {
    if (init.method === 'POST') {
      posts++;
      return Response.json(cancellationAck);
    }
    return Response.json(envelope([posts
      ? { ...swapOrder, state: 'canceled', accFillSz: '0' }
      : swapOrder]));
  }, 'MOCK_CANCELLATION');
  const results = await Promise.allSettled([
    adapter.cancelOrder(swapOrder.instId, swapOrder.ordId),
    adapter.cancelOrder(swapOrder.instId, swapOrder.ordId),
  ]);
  assert.equal(posts, 1);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.status === 409));
});
