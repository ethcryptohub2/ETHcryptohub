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
