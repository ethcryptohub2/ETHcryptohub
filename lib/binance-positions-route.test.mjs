import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadPositionsRoute(exchangePositions) {
  const source = fileURLToPath(new URL('../app/api/trading/positions/route.ts', import.meta.url));
  const routeModule = new Module(source);
  routeModule.filename = source;
  routeModule.paths = Module._nodeModulePaths(process.cwd());
  const originalLoad = Module._load;
  const signedReads = [];
  try {
    Module._load = function loadFixture(name, parent, isMain) {
      if (name.endsWith('/lib/auth')) {
        return { AuthError: class extends Error {}, requireUser: async () => ({ id: 7 }) };
      }
      if (name.endsWith('/lib/backend-proxy')) {
        return { shouldForwardToBackend: () => false };
      }
      if (name.endsWith('/lib/trading-settings')) {
        return {
          getTradingSettings: async (userId) => {
            assert.equal(userId, 7);
            return { active_environment: 'DEMO' };
          },
        };
      }
      if (name.endsWith('/lib/binance-futures')) {
        return {
          BinanceFuturesError: class extends Error { status = 502; },
          createBinanceEnvironmentAdapter: async (userId, environment) => ({
            request: async (method, path) => {
              signedReads.push({ userId, environment, method, path });
              return exchangePositions;
            },
          }),
        };
      }
      return originalLoad.call(this, name, parent, isMain);
    };
    routeModule._compile(ts.transpileModule(readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, source);
  } finally {
    Module._load = originalLoad;
  }
  return { GET: routeModule.exports.GET, signedReads };
}

const position = {
  symbol: 'ADAUSDT',
  positionSide: 'BOTH',
  positionAmt: '30',
  entryPrice: '0.385',
  markPrice: '0.41047590',
  unRealizedProfit: '0.76427700',
};

test('accepts Binance V3 positions without leverage and preserves the account-scoped read', async () => {
  const { GET, signedReads } = loadPositionsRoute([
    position,
    { ...position, symbol: 'ETHUSDT', positionAmt: '-0.25', entryPrice: '0.00000', leverage: '10' },
    { ...position, symbol: 'BTCUSDT', positionAmt: '0.000' },
  ]);
  const result = await GET();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const { data } = await result.json();
  assert.equal(data.exchange, 'BINANCE');
  assert.equal(data.virtualFunds, true);
  assert.deepEqual(data.positions.map(({ symbol, direction, entryPrice, leverage }) => ({
    symbol, direction, entryPrice, leverage,
  })), [
    { symbol: 'ADAUSDT', direction: 'LONG', entryPrice: '0.385', leverage: null },
    { symbol: 'ETHUSDT', direction: 'SHORT', entryPrice: null, leverage: '10' },
  ]);
  assert.deepEqual(signedReads, [
    { userId: 7, environment: 'DEMO', method: 'GET', path: '/fapi/v3/positionRisk' },
  ]);
});

test('preserves exchange hedge direction and rejects malformed position data', async () => {
  const hedge = loadPositionsRoute([{ ...position, positionSide: 'SHORT', positionAmt: '-30' }]);
  assert.equal((await (await hedge.GET()).json()).data.positions[0].direction, 'SHORT');
  const malformed = loadPositionsRoute([{ ...position, entryPrice: 'unknown' }]);
  const failure = await malformed.GET();
  assert.equal(failure.status, 502);
  assert.equal((await failure.json()).error, 'Binance returned an invalid position response.');
});
