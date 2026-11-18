import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'bybit-demo.ts');
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
const { BybitDemoError, createBybitDemoAdapter, signBybitDemoRequest } = sourceModule.exports;

const credentials = { apiKey: 'demo-api-key-1234', apiSecret: 'demo-secret-5678' };
const envelope = (result = {}, retCode = 0, retMsg = 'OK') => ({
  retCode,
  retMsg,
  result,
  time: Date.now(),
});

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

test('mutation guard runs after exchange reads and denies the actual HTTP POST', async () => {
  let authorized = true;
  let posts = 0;
  const mock = installFetch((url, init) => {
    if (init.method === 'POST') { posts += 1; throw new Error('unauthorized mutation'); }
    authorized = false;
    return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', positionIdx: 0, size: '0' }] }));
  });
  try {
    const adapter = createBybitDemoAdapter(credentials);
    adapter.bindMutationGuard(async () => {
      if (!authorized) throw new Error('lease expired during reads');
    });
    await assert.rejects(adapter.clearPositionProtection('BTCUSDT'), /lease expired during reads/);
    assert.equal(posts, 0);
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
});

test('signs Bybit V5 payloads with the documented HMAC-SHA256 preimage', () => {
  const payload = 'category=linear&symbol=BTCUSDT';
  const timestamp = '1730000000000';
  const expected = crypto.createHmac('sha256', credentials.apiSecret)
    .update(`${timestamp}${credentials.apiKey}5000${payload}`)
    .digest('hex');
  assert.equal(
    signBybitDemoRequest(credentials.apiSecret, timestamp, credentials.apiKey, '5000', payload),
    expected,
  );
});

test('connection test uses only the fixed Demo host and signs the private request', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-demo.bybit.com');
    assert.equal(url.pathname, '/v5/account/wallet-balance');
    assert.equal(url.searchParams.get('accountType'), 'UNIFIED');
    const timestamp = init.headers['X-BAPI-TIMESTAMP'];
    const payload = url.search.slice(1);
    assert.equal(
      init.headers['X-BAPI-SIGN'],
      signBybitDemoRequest(credentials.apiSecret, timestamp, credentials.apiKey, '5000', payload),
    );
    return Response.json(envelope({ list: [] }));
  });
  try {
    await createBybitDemoAdapter(credentials).testConnection();
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].init.headers['X-BAPI-API-KEY'], credentials.apiKey);
  } finally {
    mock.restore();
  }
});

test('rejects invalid quantity filters before submitting an order', async () => {
  let orderSubmitted = false;
  const mock = installFetch((url) => {
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '50' },
        leverageFilter: { maxLeverage: '100' },
      }] }));
    }
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', side: '', size: '0', positionIdx: 0 }] }));
    }
    if (url.pathname === '/v5/order/create') orderSubmitted = true;
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    await assert.rejects(
      createBybitDemoAdapter(credentials).placeMarketOrder({
        symbol: 'BTCUSDT', side: 'BUY', quantity: '0.0015', clientOrderId: 'test-order-1',
      }),
      (error) => error instanceof BybitDemoError && error.status === 422,
    );
    assert.equal(orderSubmitted, false);
  } finally {
    mock.restore();
  }
});

test('blocks order submission when account is in hedge mode', async () => {
  let orderSubmitted = false;
  const mock = installFetch((url) => {
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0', positionIdx: 1 }] }));
    }
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100' },
        leverageFilter: { maxLeverage: '100' },
      }] }));
    }
    if (url.pathname === '/v5/order/create') orderSubmitted = true;
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    await assert.rejects(
      createBybitDemoAdapter(credentials).placeMarketOrder({
        symbol: 'BTCUSDT', side: 'BUY', quantity: '0.001', clientOrderId: 'test-order-2',
      }),
      (error) => error instanceof BybitDemoError && error.status === 409,
    );
    assert.equal(orderSubmitted, false);
  } finally {
    mock.restore();
  }
});

test('submits a correctly signed market order only to Bybit Demo', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-demo.bybit.com');
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', side: '', size: '0', positionIdx: 0 }] }));
    }
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '50', minNotionalValue: '5' },
        leverageFilter: { maxLeverage: '100' },
      }] }));
    }
    if (url.pathname === '/v5/market/tickers') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', lastPrice: '50000', markPrice: '50000' }] }));
    }
    if (url.pathname === '/v5/order/create') {
      const timestamp = init.headers['X-BAPI-TIMESTAMP'];
      assert.equal(
        init.headers['X-BAPI-SIGN'],
        signBybitDemoRequest(credentials.apiSecret, timestamp, credentials.apiKey, '5000', init.body),
      );
      const body = JSON.parse(init.body);
      assert.deepEqual({
        category: body.category,
        symbol: body.symbol,
        side: body.side,
        orderType: body.orderType,
        qty: body.qty,
        positionIdx: body.positionIdx,
      }, {
        category: 'linear',
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Market',
        qty: '0.001',
        positionIdx: '0',
      });
      return Response.json(envelope({ orderId: '123456' }));
    }
    if (url.pathname === '/v5/order/realtime') return Response.json(envelope({ list: [] }));
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const result = await createBybitDemoAdapter(credentials).placeMarketOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: '0.001',
      clientOrderId: 'demo-order-3',
    });
    assert.equal(result.exchangeOrderId, '123456');
    assert.equal(result.status, 'Accepted');
    assert.ok(mock.calls.length > 4);
    assert.ok(mock.calls.every(({ url }) => url.origin === 'https://api-demo.bybit.com'));
  } finally {
    mock.restore();
  }
});

test('reports protection only after Bybit position data confirms both triggers', async () => {
  let positionReads = 0;
  const mock = installFetch((url) => {
    if (url.pathname === '/v5/position/list') {
      positionReads += 1;
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', side: 'Buy', size: '0.01', positionIdx: 0,
        stopLoss: positionReads === 1 ? '0' : '49000.00',
        takeProfit: positionReads === 1 ? '0' : '52000.00',
      }] }));
    }
    if (url.pathname === '/v5/position/trading-stop') return Response.json(envelope({}));
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    await createBybitDemoAdapter(credentials).setPositionProtection('BTCUSDT', '49000', '52000');
    assert.equal(positionReads, 2);
    assert.ok(mock.calls.every(({ url }) => url.origin === 'https://api-demo.bybit.com'));
  } finally {
    mock.restore();
  }
});

test('configures one full-position TP1-activated trailing stop through the fixed Demo API', async () => {
  const protection = {
    stopLoss: '49000',
    takeProfit: '52000',
    trailingStop: '1000',
    activePrice: '51000',
  };
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-demo.bybit.com');
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100' },
      }] }));
    }
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', side: 'Buy', size: '0.01', positionIdx: 0,
        avgPrice: '50000', stopLoss: '49000', takeProfit: '52000',
        trailingStop: '1000', tpslMode: 'Full',
      }] }));
    }
    if (url.pathname === '/v5/position/trading-stop') {
      assert.deepEqual(JSON.parse(init.body), {
        category: 'linear',
        symbol: 'BTCUSDT',
        tpslMode: 'Full',
        positionIdx: '0',
        ...protection,
        slTriggerBy: 'MarkPrice',
        tpTriggerBy: 'MarkPrice',
      });
      assert.equal(init.redirect, 'error');
      return Response.json(envelope({}));
    }
    if (url.pathname === '/v5/order/realtime') {
      assert.equal(url.searchParams.get('orderFilter'), 'StopOrder');
      assert.equal(url.searchParams.get('openOnly'), '0');
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT',
        orderId: 'trail-1001',
        stopOrderType: 'TrailingStop',
        triggerPrice: '51000',
        positionIdx: 0,
        tpslMode: 'Full',
      }] }));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const adapter = createBybitDemoAdapter(credentials);
    await adapter.setPositionLifecycleProtection('BTCUSDT', protection);
    const [position] = await adapter.getPositionDetails('BTCUSDT');
    assert.equal(position.trailingStop, protection.trailingStop);
    assert.equal('activePrice' in position, false);
    assert.equal(position.tpslMode, 'Full');
    assert.deepEqual(await adapter.getRealtimeTrailingStops('BTCUSDT'), [{
      symbol: 'BTCUSDT',
      orderId: 'trail-1001',
      positionIdx: 0,
      stopOrderType: 'TrailingStop',
      triggerPrice: protection.activePrice,
      tpslMode: 'Full',
    }]);
    assert.ok(mock.calls.every(({ url, init }) =>
      url.origin === 'https://api-demo.bybit.com' && init.redirect === 'error'));
  } finally {
    mock.restore();
  }
});

test('maps Bybit rate-limit responses without retrying', async () => {
  let calls = 0;
  const mock = installFetch(() => {
    calls += 1;
    return Response.json(envelope({}, 10006, 'Too many visits'));
  });
  try {
    await assert.rejects(
      createBybitDemoAdapter(credentials).testConnection(),
      (error) => error instanceof BybitDemoError && error.status === 429 && error.retCode === 10006,
    );
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test('normalizes Demo wallet, available balance, equity, and unrealized PnL', async () => {
  const mock = installFetch(() => Response.json(envelope({
    list: [{
      totalWalletBalance: '1000.25',
      totalAvailableBalance: '825.50',
      totalEquity: '1032.75',
      totalPerpUPL: '32.50',
    }],
  })));
  try {
    assert.deepEqual(await createBybitDemoAdapter(credentials).getAccountBalance(), [{
      asset: 'USDT',
      walletBalance: '1000.25',
      availableBalance: '825.50',
      equity: '1032.75',
      unrealizedPnl: '32.50',
    }]);
    assert.equal(mock.calls[0].url.origin, 'https://api-demo.bybit.com');
  } finally {
    mock.restore();
  }
});

test('places SHORT market and limit orders, then cancels on the fixed Demo API', async () => {
  const mock = installFetch((url, init) => {
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', side: '', size: '0', positionIdx: 0 }] }));
    }
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '50' },
      }] }));
    }
    if (url.pathname === '/v5/market/tickers') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', lastPrice: '50000', markPrice: '50000' }] }));
    }
    if (url.pathname === '/v5/order/create') {
      const body = JSON.parse(init.body);
      if (body.orderType === 'Market') {
        assert.equal(body.side, 'Sell');
        assert.equal(body.orderLinkId, 'short-order-4');
        return Response.json(envelope({ orderId: '4001' }));
      }
      assert.equal(body.orderType, 'Limit');
      assert.equal(body.side, 'Buy');
      assert.equal(body.timeInForce, 'GTC');
      assert.equal(body.price, '50000.1');
      assert.equal(body.stopLoss, '49000');
      assert.equal(body.takeProfit, '52000');
      assert.equal(body.tpslMode, 'Full');
      assert.equal(body.slOrderType, 'Market');
      assert.equal(body.tpOrderType, 'Market');
      assert.equal(body.slTriggerBy, 'MarkPrice');
      assert.equal(body.tpTriggerBy, 'MarkPrice');
      return Response.json(envelope({ orderId: '4002' }));
    }
    if (url.pathname === '/v5/order/realtime') {
      const orderLinkId = url.searchParams.get('orderLinkId');
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT',
        orderId: orderLinkId === 'short-order-4' ? '4001' : '4002',
        orderLinkId,
        side: orderLinkId === 'short-order-4' ? 'Sell' : 'Buy',
        orderType: orderLinkId === 'short-order-4' ? 'Market' : 'Limit',
        orderStatus: 'New',
        qty: '0.01',
        cumExecQty: '0',
        price: orderLinkId === 'short-order-4' ? '0' : '50000.1',
      }] }));
    }
    if (url.pathname === '/v5/order/cancel') {
      assert.deepEqual(JSON.parse(init.body), { category: 'linear', symbol: 'BTCUSDT', orderId: '4002' });
      return Response.json(envelope({ orderId: '4002', orderLinkId: 'limit-order-5' }));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const adapter = createBybitDemoAdapter(credentials);
    const short = await adapter.placeMarketOrder({
      symbol: 'BTCUSDT', side: 'SELL', quantity: '0.01', clientOrderId: 'short-order-4',
    });
    assert.equal(short.side, 'SELL');
    assert.equal(short.status, 'New');

    const limit = await adapter.placeLimitOrder({
      symbol: 'BTCUSDT', side: 'BUY', quantity: '0.01', price: '50000.1', clientOrderId: 'limit-order-5',
      initialProtection: { stopLoss: '49000', takeProfit: '52000' },
    });
    assert.equal(limit.exchangeOrderId, '4002');
    await adapter.cancelOrder('BTCUSDT', '4002');
    assert.ok(mock.calls.every(({ url }) => url.origin === 'https://api-demo.bybit.com'));
  } finally {
    mock.restore();
  }
});

test('reconciles an accepted order after a network failure without resubmitting', async () => {
  let submissions = 0;
  const mock = installFetch((url) => {
    if (url.pathname === '/v5/position/list') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', side: '', size: '0', positionIdx: 0 }] }));
    }
    if (url.pathname === '/v5/market/instruments-info') {
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading',
        baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '50' },
      }] }));
    }
    if (url.pathname === '/v5/market/tickers') {
      return Response.json(envelope({ list: [{ symbol: 'BTCUSDT', lastPrice: '50000', markPrice: '50000' }] }));
    }
    if (url.pathname === '/v5/order/create') {
      submissions += 1;
      throw new TypeError('connection reset');
    }
    if (url.pathname === '/v5/order/realtime') {
      assert.equal(url.searchParams.get('orderLinkId'), 'uncertain-order-6');
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT', orderId: '6001', orderLinkId: 'uncertain-order-6',
        side: 'Buy', orderType: 'Market', orderStatus: 'Filled',
        qty: '0.01', cumExecQty: '0.01', price: '50000',
      }] }));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const result = await createBybitDemoAdapter(credentials).placeMarketOrder({
      symbol: 'BTCUSDT', side: 'BUY', quantity: '0.01', clientOrderId: 'uncertain-order-6',
    });
    assert.equal(result.exchangeOrderId, '6001');
    assert.equal(result.status, 'Filled');
    assert.equal(submissions, 1);
  } finally {
    mock.restore();
  }
});

test('reconciles filled orders from history when they are no longer realtime orders', async () => {
  const mock = installFetch((url) => {
    assert.equal(url.origin, 'https://api-demo.bybit.com');
    if (url.pathname === '/v5/order/realtime') {
      return Response.json(envelope({ list: [] }));
    }
    if (url.pathname === '/v5/order/history') {
      assert.equal(url.searchParams.get('category'), 'linear');
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
      assert.equal(url.searchParams.get('orderLinkId'), 'closed-order-7');
      return Response.json(envelope({ list: [{
        symbol: 'BTCUSDT',
        orderId: '7001',
        orderLinkId: 'closed-order-7',
        side: 'Sell',
        orderType: 'Market',
        orderStatus: 'Filled',
        qty: '0.01',
        cumExecQty: '0.01',
        price: '49000',
      }] }));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  try {
    const order = await createBybitDemoAdapter(credentials).reconcileOrder('BTCUSDT', 'closed-order-7');
    assert.equal(order.exchangeOrderId, '7001');
    assert.equal(order.status, 'Filled');
    assert.equal(order.filledQuantity, '0.01');
  } finally {
    mock.restore();
  }
});

test('maps Bybit timestamp-window errors to an actionable validation response', async () => {
  const mock = installFetch(() => Response.json(envelope({}, 10002, 'invalid request, please check your server timestamp')));
  try {
    await assert.rejects(
      createBybitDemoAdapter(credentials).testConnection(),
      (error) => error instanceof BybitDemoError &&
        error.status === 422 &&
        error.retCode === 10002 &&
        error.message.includes('server clock synchronization'),
    );
  } finally {
    mock.restore();
  }
});
