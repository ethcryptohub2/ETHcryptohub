import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'gate-testnet.ts');
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
  GATE_TESTNET_ACCESS_URL_DOCUMENTATION,
  GATE_TESTNET_AUTH_DOCUMENTATION,
  GATE_TESTNET_CAPABILITIES,
  GATE_TESTNET_DOCUMENTATION_URL,
  GATE_TESTNET_UNSUPPORTED_CAPABILITIES,
  GateTestnetError,
  createGateTestnetAdapter,
  signGateTestnetRequest,
} = sourceModule.exports;

const credentials = { apiKey: 'gate-testnet-key', apiSecret: 'gate-testnet-secret' };
const account = {
  currency: 'USDT',
  total: '120.5',
  available: '100.25',
  unrealised_pnl: '2.75',
  in_dual_mode: true,
};

function installFetch(handler) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore() { global.fetch = originalFetch; },
  };
}

test('Gate HMAC-SHA512 signature matches the official APIv4 example', () => {
  const signature = signGateTestnetRequest(
    'secret',
    'GET',
    '/api/v4/futures/orders',
    'contract=BTC_USD&status=finished&limit=50',
    '1541993715',
  );
  assert.equal(
    signature,
    '55f84ea195d6fe57ce62464daaa7c3c02fa9d1dde954e4c898289c9a2407a3d6fb3faf24deff16790d726b66ac9f74526668b13bd01029199cc4fcc522418b8a',
  );
  assert.equal(GATE_TESTNET_DOCUMENTATION_URL, 'https://www.gate.com/docs/developers/apiv4/en/');
  assert.equal(GATE_TESTNET_ACCESS_URL_DOCUMENTATION, `${GATE_TESTNET_DOCUMENTATION_URL}#access-url`);
  assert.equal(GATE_TESTNET_AUTH_DOCUMENTATION, `${GATE_TESTNET_DOCUMENTATION_URL}#authentication`);
});

test('Gate rejects Demo and Live environments and exposes no execution methods', () => {
  assert.throws(
    () => createGateTestnetAdapter(credentials, 'DEMO'),
    (error) => error instanceof GateTestnetError && error.status === 422,
  );
  assert.throws(
    () => createGateTestnetAdapter(credentials, 'LIVE'),
    (error) => error instanceof GateTestnetError && error.status === 422,
  );
  const adapter = createGateTestnetAdapter(credentials);
  assert.equal(adapter.exchange, 'GATE');
  assert.equal(adapter.environment, 'TESTNET');
  assert.equal(adapter.capabilities.connectionTest, true);
  assert.equal(adapter.capabilities.balance, true);
  assert.equal(adapter.capabilities.instruments, true);
  assert.equal(adapter.capabilities.positions, true);
  assert.ok(GATE_TESTNET_UNSUPPORTED_CAPABILITIES.includes('marketEntry'));
  assert.ok(GATE_TESTNET_UNSUPPORTED_CAPABILITIES.includes('stopLossProtection'));
  assert.ok(Object.entries(GATE_TESTNET_CAPABILITIES)
    .filter(([name]) => name !== 'connectionTest' && name !== 'balance' && name !== 'instruments' && name !== 'positions')
    .every(([, enabled]) => !enabled));
  assert.equal(adapter.placeMarketOrder, undefined);
  assert.equal(adapter.placeLimitOrder, undefined);
  assert.equal(adapter.closePosition, undefined);
  assert.equal(adapter.cancelOrder, undefined);
});

const gateOrder = {
  id: '1753197687182819328', contract: 'BTC_USDT', text: 't-entry-1',
  size: '-1.005', left: '-0.830', status: 'open', price: '50000.00', tif: 'gtc', is_reduce_only: true,
};

const fixtureCredentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret' };
const canceledOrder = { ...gateOrder, status: 'finished', finish_as: 'cancelled' };

test('Gate mock limit entry signs exact decimals, reconciles independently and replays without another POST', async () => {
  const order = { ...gateOrder, left: '-1.005', is_reduce_only: false };
  const intent = { symbol: order.contract, side: 'SELL', quantity: '1.005', price: '50000.00', clientOrderId: order.text };
  const requests = [];
  const adapter = createGateTestnetAdapter(fixtureCredentials, 'TESTNET', async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-testnet.gateapi.io');
    assert.equal(init.redirect, 'error');
    requests.push([init.method, url.pathname.split('/').at(-1)]);
    if (url.pathname.endsWith('/accounts')) return Response.json({ ...account, in_dual_mode: false });
    if (url.pathname.includes('/contracts/')) {
      assert.equal(init.headers.KEY, undefined);
      return Response.json({
        name: order.contract, type: 'direct', order_price_round: '0.10', order_size_min: '0.001',
        order_size_max: '10', quanto_multiplier: '0.001', trade_status: 'tradable',
        in_delisting: false, enable_decimal: true,
      });
    }
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), {
        contract: order.contract, size: '-1.005', price: '50000.00', tif: 'gtc', text: order.text, reduce_only: false,
      });
      assert.equal(init.headers['X-Gate-Size-Decimal'], '1');
      assert.equal(init.headers.SIGN, signGateTestnetRequest(
        fixtureCredentials.apiSecret, 'POST', url.pathname, '', init.headers.Timestamp, init.body,
      ));
    } else if (requests.length === 1) {
      return Response.json({ label: 'ORDER_NOT_FOUND' }, { status: 404 });
    }
    return new Response(JSON.stringify(order).replace(`"${order.id}"`, order.id));
  }, 'MOCK_LIMIT_LIFECYCLE');
  const result = await adapter.placeFixtureLimitOrder(intent);
  assert.equal(result.exchangeOrderId, order.id);
  assert.equal(result.status, 'OPEN');
  assert.equal(result.quantity, '1.005');
  assert.deepEqual(await adapter.placeFixtureLimitOrder(intent), result);
  assert.deepEqual(requests, [
    ['GET', order.text], ['GET', 'accounts'], ['GET', order.contract],
    ['POST', 'orders'], ['GET', order.id], ['GET', order.text],
  ]);
  assert.equal(adapter.capabilities.adminLifecycle, false);
});

test('Gate mock limit entry rejects wrong account mode before mutation and ordinary adapters expose no submission', async () => {
  const adapter = createGateTestnetAdapter(fixtureCredentials, 'TESTNET', async (input, init) => {
    assert.equal(init.method, 'GET');
    return new URL(input).pathname.endsWith('/accounts')
      ? Response.json(account)
      : Response.json({ label: 'ORDER_NOT_FOUND' }, { status: 404 });
  }, 'MOCK_LIMIT_LIFECYCLE');
  await assert.rejects(adapter.placeFixtureLimitOrder({
    symbol: 'BTC_USDT', side: 'SELL', quantity: '1.005', price: '50000.00', clientOrderId: 't-entry-1',
  }), /one-way USDT/);
  assert.equal(createGateTestnetAdapter(credentials).placeFixtureLimitOrder, undefined);
});

test('Gate fixture cancels one exact USDT order and verifies terminal state with independent GET', async () => {
  const calls = [];
  const cancellation = createGateTestnetAdapter(fixtureCredentials, 'TESTNET', async (input, init) => {
    const url = new URL(input);
    assert.equal(url.href, `https://api-testnet.gateapi.io/api/v4/futures/usdt/orders/${gateOrder.id}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Gate-Size-Decimal'], '1');
    assert.equal(init.headers.KEY, fixtureCredentials.apiKey);
    assert.equal(init.body, undefined);
    assert.equal(init.headers.SIGN, signGateTestnetRequest(
      fixtureCredentials.apiSecret, init.method, url.pathname, '', init.headers.Timestamp,
    ));
    calls.push(init.method);
    const order = calls.length === 1 ? gateOrder : canceledOrder;
    return new Response(JSON.stringify(order).replace(`"${order.id}"`, order.id));
  }, 'MOCK_CANCELLATION');
  const result = await cancellation.cancelOrder(gateOrder.contract, gateOrder.id);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.filledQuantity, '0.175');
  assert.equal(result.reduceOnly, true);
  assert.equal(cancellation.capabilities.adminLifecycle, false);
  assert.equal((await cancellation.cancelOrder(gateOrder.contract, gateOrder.id)).status, 'CANCELLED');
  assert.deepEqual(calls, ['GET', 'DELETE', 'GET', 'GET']);
});

test('Gate fixture requires synthetic Testnet configuration and rejects ambiguous cancellation without resubmission', async () => {
  const unused = async () => assert.fail('unexpected fixture request');
  assert.throws(() => createGateTestnetAdapter(credentials, 'TESTNET', unused, 'MOCK_CANCELLATION'), { status: 422 });
  assert.throws(() => createGateTestnetAdapter(fixtureCredentials, 'LIVE', unused, 'MOCK_CANCELLATION'), { status: 422 });
  assert.throws(() => createGateTestnetAdapter(fixtureCredentials, 'TESTNET', fetch, 'MOCK_CANCELLATION'), { status: 422 });
  for (const acknowledgment of [
    () => { throw new Error('transport disconnected'); },
    () => Response.json({ ...canceledOrder, contract: 'ETH_USDT' }),
    () => Response.json({ ...canceledOrder, left: '-1.005' }),
    () => Response.json(canceledOrder),
  ]) {
    let deletes = 0;
    const fixture = createGateTestnetAdapter(fixtureCredentials, 'TESTNET', async (_, init) => {
      if (init.method === 'GET') return Response.json(gateOrder);
      deletes++;
      return acknowledgment();
    }, 'MOCK_CANCELLATION');
    await assert.rejects(fixture.cancelOrder(gateOrder.contract, gateOrder.id), /Reconcile the original order/);
    await assert.rejects(fixture.cancelOrder(gateOrder.contract, gateOrder.id), /already attempted cancellation/);
    assert.equal(deletes, 1);
  }
});

test('Gate cancellation rejects custom IDs and other contracts before a mutation', async () => {
  const methods = [];
  const fixture = createGateTestnetAdapter(fixtureCredentials, 'TESTNET', async (_, init) => {
    methods.push(init.method);
    return Response.json(gateOrder);
  }, 'MOCK_CANCELLATION');
  await assert.rejects(fixture.cancelOrder('BTC_USD', gateOrder.id), { status: 422 });
  await assert.rejects(fixture.cancelOrder(gateOrder.contract, gateOrder.text), { status: 422 });
  await assert.rejects(fixture.cancelOrder('ETH_USDT', gateOrder.id), { status: 502 });
  assert.deepEqual(methods, ['GET']);
});

test('Gate signed lookup preserves numeric int64 IDs and exact fractional contracts', async () => {
  const paths = [];
  const transport = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-testnet.gateapi.io');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Gate-Size-Decimal'], '1');
    assert.equal(init.headers.KEY, credentials.apiKey);
    assert.equal(init.headers.SIGN, signGateTestnetRequest(
      credentials.apiSecret, 'GET', url.pathname, '', init.headers.Timestamp,
    ));
    paths.push(url.pathname);
    // Gate's documented int64 field is an unquoted number on the wire.
    const raw = JSON.stringify(gateOrder).replace(`"${gateOrder.id}"`, gateOrder.id);
    return new Response(raw);
  };
  const adapter = createGateTestnetAdapter(credentials, 'TESTNET', transport);
  const order = await adapter.getOrderStatus(gateOrder.contract, gateOrder.id);
  assert.deepEqual(order, {
    symbol: gateOrder.contract, exchangeOrderId: gateOrder.id, clientOrderId: 't-entry-1',
    status: 'PARTIALLY_FILLED', side: 'SELL', type: 'LIMIT', quantity: '1.005', filledQuantity: '0.175',
    price: '50000.00', finishReason: null, reduceOnly: true,
  });
  assert.deepEqual(await adapter.reconcileOrder(gateOrder.contract, gateOrder.text), order);
  assert.deepEqual(paths, [
    `/api/v4/futures/usdt/orders/${gateOrder.id}`,
    '/api/v4/futures/usdt/orders/t-entry-1',
  ]);
});

test('Gate unresolved retention absence never becomes a successful reconciliation', async () => {
  const responses = [
    Response.json({ label: 'ORDER_NOT_FOUND' }, { status: 404 }),
    Response.json({ label: 'INVALID_KEY' }, { status: 401 }),
    Response.json({ label: 'UNKNOWN' }, { status: 404 }),
    Response.json({}, { status: 429 }),
    Response.json(null),
    Response.json({ ...gateOrder, contract: 'ETH_USDT' }),
    Response.json({ ...gateOrder, left: '2.00' }),
    Response.json({ ...gateOrder, finish_as: 'filled', status: 'finished' }),
  ];
  let calls = 0;
  const adapter = createGateTestnetAdapter(credentials, 'TESTNET', async () => {
    calls++;
    return responses.shift();
  });
  await assert.rejects(createGateTestnetAdapter(credentials).reconcileOrder('BTC_USDT', 't-entry-1'), { status: 501 });
  await assert.rejects(adapter.reconcileOrder('BTC_USDT', 't-../orders'), { status: 422 });
  await assert.rejects(adapter.getOrderStatus('BTC_USD', gateOrder.id), { status: 422 });
  assert.equal(calls, 0);
  assert.equal(await adapter.reconcileOrder('BTC_USDT', 't-entry-1'), null);
  for (const status of [502, 502, 429, 502, 502, 502, 502]) {
    await assert.rejects(adapter.getOrderStatus('BTC_USDT', gateOrder.id), { status });
  }
  assert.equal(calls, 8);
});

test('Gate connection and balance use signed GETs on the fixed Futures Testnet host', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-testnet.gateapi.io');
    assert.equal(url.pathname, '/api/v4/futures/usdt/accounts');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.KEY, credentials.apiKey);
    assert.equal(init.headers.Timestamp, String(Math.floor(Date.now() / 1000)));
    assert.equal(
      init.headers.SIGN,
      signGateTestnetRequest(
        credentials.apiSecret,
        'GET',
        '/api/v4/futures/usdt/accounts',
        '',
        init.headers.Timestamp,
      ),
    );
    return Response.json(account);
  });
  try {
    const adapter = createGateTestnetAdapter(credentials, 'TESTNET');
    await adapter.testConnection();
    assert.deepEqual(await adapter.getAccountBalance(), [{
      asset: 'USDT',
      walletBalance: '120.5',
      availableBalance: '100.25',
      unrealizedPnl: '2.75',
    }]);
    assert.equal(mock.calls.length, 2);
    assert.ok(mock.calls.every(({ url, init }) =>
      url.origin === 'https://api-testnet.gateapi.io' && init.method === 'GET'));
  } finally {
    mock.restore();
  }
});

test('Gate normalizes USDT futures contracts from Testnet without private credentials on the public request', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-testnet.gateapi.io');
    assert.equal(url.pathname, '/api/v4/futures/usdt/contracts');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.KEY, undefined);
    return Response.json([
      {
        name: 'BTC_USDT',
        type: 'direct',
        order_price_round: '0.1',
        order_size_min: '1',
        order_size_max: '1000000',
        quanto_multiplier: '0.0001',
        leverage_max: '100',
        trade_status: 'tradable',
      },
      {
        name: 'BTC_USDT_20261231',
        type: 'direct',
        order_price_round: '0.1',
        order_size_min: '1',
        quanto_multiplier: '0.0001',
        in_delisting: false,
        enable_decimal: true,
      },
    ]);
  });
  try {
    const instruments = await createGateTestnetAdapter(credentials).getMarketInstruments();
    assert.deepEqual(instruments, [
      {
        exchangeSymbol: 'BTC_USDT',
        smartExitSymbol: 'BTC_USDT',
        contractType: 'PERPETUAL',
        quoteAsset: 'USDT',
        status: 'tradable',
        tickSize: '0.1',
        quantityStep: '1',
        minimumQuantity: '1',
        maximumQuantity: '1000000',
        minimumNotional: null,
        contractSize: '0.0001',
        maximumLeverage: 100,
      },
      {
        exchangeSymbol: 'BTC_USDT_20261231',
        smartExitSymbol: 'BTC_USDT_20261231',
        contractType: 'OTHER',
        quoteAsset: 'USDT',
        status: 'tradable',
        tickSize: '0.1',
        quantityStep: '1',
        minimumQuantity: '1',
        maximumQuantity: null,
        minimumNotional: null,
        contractSize: '0.0001',
        maximumLeverage: null,
      },
    ]);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('Gate normalizes single-side signed and dual-side position modes without assuming account mode', async () => {
  const mock = installFetch((url, init) => {
    assert.equal(url.origin, 'https://api-testnet.gateapi.io');
    assert.equal(url.pathname, '/api/v4/futures/usdt/positions');
    assert.equal(init.method, 'GET');
    assert.ok(init.headers.SIGN);
    return Response.json([
      {
        contract: 'BTC_USDT',
        size: '3',
        mode: 'single',
        entry_price: '60000',
        mark_price: '60100',
        unrealised_pnl: '30',
        leverage: '5',
      },
      {
        contract: 'ETH_USDT',
        size: '-2',
        mode: 'single',
        entry_price: '3000',
        mark_price: '2990',
        unrealised_pnl: '-20',
      },
      {
        contract: 'SOL_USDT',
        size: '4',
        mode: 'dual_short',
        entry_price: '100',
        unrealised_pnl: '1',
      },
      {
        contract: 'XRP_USDT',
        size: '0',
        mode: 'single',
        entry_price: '1',
        unrealised_pnl: '0',
      },
    ]);
  });
  try {
    const positions = await createGateTestnetAdapter(credentials).getPositions();
    assert.deepEqual(positions, [
      {
        symbol: 'BTC_USDT',
        side: 'LONG',
        quantity: '3',
        entryPrice: '60000',
        markPrice: '60100',
        unrealizedPnl: '30',
        leverage: 5,
      },
      {
        symbol: 'ETH_USDT',
        side: 'SHORT',
        quantity: '2',
        entryPrice: '3000',
        markPrice: '2990',
        unrealizedPnl: '-20',
        leverage: null,
      },
      {
        symbol: 'SOL_USDT',
        side: 'SHORT',
        quantity: '4',
        entryPrice: '100',
        markPrice: null,
        unrealizedPnl: '1',
        leverage: null,
      },
    ]);
  } finally {
    mock.restore();
  }
});
