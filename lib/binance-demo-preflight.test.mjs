import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'binance-demo-preflight.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const { assertBinanceDemoOnly, inspectBinanceDemoReadiness } = sourceModule.exports;

const demoUrl = 'https://demo-fapi.binance.com';

function fakeAdapter(overrides = {}) {
  const calls = [];
  const adapter = {
    environment: 'DEMO',
    baseUrl: demoUrl,
    async request(method, endpoint, parameters) {
      calls.push({ kind: 'signed', method, endpoint, parameters });
      if (endpoint === '/fapi/v3/account') return { canTrade: true };
      if (endpoint === '/fapi/v1/positionSide/dual') return { dualSidePosition: false };
      throw new Error(`Unexpected signed request: ${endpoint}`);
    },
    async publicRequest(endpoint) {
      calls.push({ kind: 'public', method: 'GET', endpoint });
      if (endpoint === '/fapi/v1/exchangeInfo') return {
        symbols: [{
          symbol: 'BTCUSDT',
          status: 'TRADING',
          contractType: 'PERPETUAL',
          quoteAsset: 'USDT',
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '0.10', maxPrice: '1000000.00' },
            { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100.000', stepSize: '0.001' },
            { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '50.000', stepSize: '0.001' },
            { filterType: 'MIN_NOTIONAL', notional: '5.0', applyToMarket: true },
          ],
        }],
      };
      if (endpoint === '/fapi/v1/premiumIndex?symbol=BTCUSDT') return { markPrice: '50000.00' };
      throw new Error(`Unexpected public request: ${endpoint}`);
    },
    ...overrides,
  };
  return { adapter, calls };
}

test('read-only Demo preflight checks permissions, One-way mode and symbol filters', async () => {
  const { adapter, calls } = fakeAdapter();
  const result = await inspectBinanceDemoReadiness(adapter, {
    environment: 'DEMO', symbol: 'BTCUSDT', quantity: '0.001',
  });
  assert.equal(result.ready, true);
  assert.equal(result.ordersPlaced, false);
  assert.equal(result.endpoint, demoUrl);
  assert.equal(result.minimumNotionalUsdt, '5.0');
  assert.deepEqual(calls.map(({ method, endpoint }) => [method, endpoint]), [
    ['GET', '/fapi/v3/account'],
    ['GET', '/fapi/v1/positionSide/dual'],
    ['GET', '/fapi/v1/exchangeInfo'],
    ['GET', '/fapi/v1/premiumIndex?symbol=BTCUSDT'],
  ]);
  assert.equal(calls.some(({ endpoint }) => /order|leverage|algo/i.test(endpoint)), false);
});

test('preflight rejects LIVE before making any exchange request', async () => {
  const { adapter, calls } = fakeAdapter();
  assert.throws(() => assertBinanceDemoOnly('LIVE'), /DEMO only/);
  await assert.rejects(
    inspectBinanceDemoReadiness(adapter, {
      environment: 'LIVE', symbol: 'BTCUSDT', quantity: '0.001',
    }),
    /DEMO only/,
  );
  assert.equal(calls.length, 0);
});

test('preflight rejects a non-Demo adapter before contacting it', async () => {
  const { adapter, calls } = fakeAdapter({ baseUrl: 'https://fapi.binance.com' });
  await assert.rejects(
    inspectBinanceDemoReadiness(adapter, { symbol: 'BTCUSDT', quantity: '0.001' }),
    /fixed Binance Futures Demo endpoint/,
  );
  assert.equal(calls.length, 0);
});

test('preflight reports disabled account permission and Hedge Mode as not ready', async () => {
  const { adapter } = fakeAdapter({
    async request(_method, endpoint) {
      if (endpoint === '/fapi/v3/account') return { canTrade: false };
      if (endpoint === '/fapi/v1/positionSide/dual') return { dualSidePosition: true };
      throw new Error(`Unexpected signed request: ${endpoint}`);
    },
  });
  const result = await inspectBinanceDemoReadiness(adapter, {
    symbol: 'BTCUSDT', quantity: '0.001',
  });
  assert.equal(result.checks.accountCanTrade, false);
  assert.equal(result.checks.oneWayPositionMode, false);
  assert.equal(result.ready, false);
});

test('preflight rejects quantities that violate exchange steps or minimum notional', async () => {
  const { adapter } = fakeAdapter();
  const offStep = await inspectBinanceDemoReadiness(adapter, {
    symbol: 'BTCUSDT', quantity: '0.0015',
  });
  assert.equal(offStep.checks.quantityFitsLotSize, false);
  assert.equal(offStep.checks.quantityFitsMarketLotSize, false);
  assert.equal(offStep.ready, false);

  const tooSmall = await inspectBinanceDemoReadiness(adapter, {
    symbol: 'BTCUSDT', quantity: '0.001',
  });
  const publicRequest = adapter.publicRequest.bind(adapter);
  adapter.publicRequest = async (endpoint) => endpoint.includes('premiumIndex')
    ? { markPrice: '1000.00' }
    : publicRequest(endpoint);
  const underMinimum = await inspectBinanceDemoReadiness(adapter, {
    symbol: 'BTCUSDT', quantity: '0.001',
  });
  assert.equal(tooSmall.checks.notionalSufficient, true);
  assert.equal(underMinimum.notionalUsdt, '1');
  assert.equal(underMinimum.checks.notionalSufficient, false);
  assert.equal(underMinimum.ready, false);
});

test('preflight reports unavailable symbols and never requests mark data for them', async () => {
  const { adapter, calls } = fakeAdapter();
  const result = await inspectBinanceDemoReadiness(adapter, {
    symbol: 'NOTUSDT', quantity: '1',
  });
  assert.equal(result.checks.usdtPerpetualTrading, false);
  assert.equal(result.ready, false);
  assert.equal(calls.some(({ endpoint }) => endpoint.includes('premiumIndex')), false);
});
