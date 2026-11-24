import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function load(file, stubs = {}) {
  const filename = path.resolve(file);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const delegate = mod.require.bind(mod);
  mod.require = (key) => Object.hasOwn(stubs, key) ? stubs[key] : delegate(key);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

test('isEligibleScannerCoin accepts 5-character symbols (1-char base asset)', () => {
  const { isEligibleScannerCoin } = load('lib/scanner-coins.ts', {
    './db': { query: async () => ({ rows: [] }) },
    './pagination': load('lib/pagination.ts'),
    '../smartexit/apps/api/src/services/binance-futures-markets': {
      fetchBinanceUsdtPerpetuals: async () => [],
    },
  });

  const tUsdt = {
    exchange: 'BINANCE',
    symbol: 'TUSDT',
    base_asset: 'T',
    quote_asset: 'USDT',
    contract_type: 'PERPETUAL',
    trading_status: 'TRADING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(tUsdt), true, 'TUSDT should be eligible');

  const wUsdt = {
    exchange: 'BINANCE',
    symbol: 'WUSDT',
    base_asset: 'W',
    quote_asset: 'USDT',
    contract_type: 'PERPETUAL',
    trading_status: 'TRADING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(wUsdt), true, 'WUSDT should be eligible');

  const btcUsdt = {
    exchange: 'BINANCE',
    symbol: 'BTCUSDT',
    base_asset: 'BTC',
    quote_asset: 'USDT',
    contract_type: 'PERPETUAL',
    trading_status: 'TRADING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(btcUsdt), true, 'BTCUSDT should be eligible');

  const usdcCoin = {
    exchange: 'BINANCE',
    symbol: 'BTCUSDC',
    base_asset: 'BTC',
    quote_asset: 'USDC',
    contract_type: 'PERPETUAL',
    trading_status: 'TRADING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(usdcCoin), false, 'USDC quote should be excluded');

  const settlingCoin = {
    exchange: 'BINANCE',
    symbol: 'OMGUSDT',
    base_asset: 'OMG',
    quote_asset: 'USDT',
    contract_type: 'PERPETUAL',
    trading_status: 'SETTLING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(settlingCoin), false, 'SETTLING status should be excluded');
});

test('isEligibleScannerCoin accepts Unicode Chinese perpetual contracts', () => {
  const { isEligibleScannerCoin } = load('lib/scanner-coins.ts', {
    './db': { query: async () => ({ rows: [] }) },
    './pagination': load('lib/pagination.ts'),
    '../smartexit/apps/api/src/services/binance-futures-markets': {
      fetchBinanceUsdtPerpetuals: async () => [],
    },
  });

  const memeCoin = {
    exchange: 'BINANCE',
    symbol: '哈基米USDT',
    base_asset: '哈基米',
    quote_asset: 'USDT',
    contract_type: 'PERPETUAL',
    trading_status: 'TRADING',
    is_enabled: true,
  };
  assert.equal(isEligibleScannerCoin(memeCoin), true, 'Unicode contract should be eligible');
});

test('getAndAdvanceScannerCursor calculates 15 batches for 522 items and produces stable cycleId', async () => {
  const { getAndAdvanceScannerCursor } = load('lib/signal-scan.ts', {
    './db': {
      query: async (sql) => {
        if (sql.includes('SELECT value_json FROM public.app_settings')) {
          return { rows: [{ value_json: { cursor: 0, cycleCount: 1, lastScannedAt: null } }] };
        }
        return { rows: [] };
      },
    },
    './market-research-settings': { getMarketResearchSettings: async () => ({}) },
    './scanner-coins': { getEnabledScannerSymbols: async () => [] },
    './signal-persistence': { saveScannerCandidates: async () => {}, persistSignalScan: async () => ({ created: 0, createdSignalIds: [] }) },
    './signal-lifecycle': { processSignalLifecycle: async () => {} },
    './trading-execution': { processNewAutomaticTrades: async () => {} },
    './notifications': { flushSignalNotifications: async () => {} },
    '../smartexit/apps/api/src/services/market-scanner': { BinanceMarketScannerService: class {} },
    '../smartexit/apps/api/src/services/binance-futures-markets': { BinanceFuturesMarketsService: class {} },
  });

  const result = await getAndAdvanceScannerCursor(522, 35);
  assert.equal(result.totalBatches, 15, '522 items / 35 limit should equal 15 batches');
  assert.match(result.cycleId, /^CYCLE-\d+-FULL-RUN$/, 'cycleId should have format CYCLE-{n}-FULL-RUN');
});
