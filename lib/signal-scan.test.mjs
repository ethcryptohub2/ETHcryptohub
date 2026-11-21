import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'signal-scan.ts');
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
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const calls = [];
const originalLoad = Module._load;

class MockBinanceFuturesMarketsService {
  async list() {
    return [];
  }
}

class MockBinanceMarketScannerService {
  async scan() {
    return { status: 'DEGRADED', exchange: 'BINANCE', source: 'fixture', updatedAt: new Date().toISOString(),
      candidates: [{ symbol: 'BTCUSDT', status: 'WAIT', side: 'WAIT', warnings: ['EMA trend is based on candle closes', 'Volume below minimum'],
        lastCandleCloseAt: '2026-11-21T09:44:59.999Z', rationale: 'WAIT', setup: null }] };
  }
}

try {
  Module._load = function load(request, parent, isMain) {
    if (request.endsWith('/binance-futures-markets')) {
      return { BinanceFuturesMarketsService: MockBinanceFuturesMarketsService };
    }
    if (request.endsWith('/market-scanner')) {
      return {
        BinanceMarketScannerService: MockBinanceMarketScannerService,
        recommendedMaxAgeSeconds: () => 120,
      };
    }
    if (request === './market-research-settings') return { loadMarketResearchProvider: async () => null };
    if (request === './notifications') {
      return {
        async flushSignalNotifications() { calls.push('flush'); },
        async getNotificationSystemSettings() { return { minimumSetupScore: 0 }; },
        async persistSignalScan(_candidates, _settings, options) {
          calls.push('persist');
          calls.push(['notification-dispatch', options.dispatchNotifications]);
          return { created: 1, createdSignalIds: ['signal-1'] };
        },
        async processSignalLifecycle() { calls.push('lifecycle'); },
      };
    }
    if (request === './trading-execution') {
      return {
        async processNewAutomaticTrades(signalIds) {
          calls.push(['automatic-trades', signalIds]);
        },
      };
    }
    if (request === './scanner-coins') {
      return {
        async getEnabledScannerSymbols() { return ['BTCUSDT', 'ETHUSDT']; },
        async getScannerSyncState() { return { last_attempt_at: new Date().toISOString() }; },
        async saveScannerCandidates() { calls.push('save'); },
        async syncBinanceScannerUniverse() { calls.push('sync'); },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  sourceModule._compile(compiled.outputText, sourcePath);
} finally {
  Module._load = originalLoad;
}

const { runSignalScan } = sourceModule.exports;

test('safe manual scans persist signals without invoking automatic trading', async () => {
  calls.length = 0;
  const result = await runSignalScan('15m', { executeAutomaticTrades: false, deliverNotifications: false });

  assert.equal(result.candidates, 1);
  assert.equal(calls.includes('persist'), true);
  assert.equal(calls.includes('lifecycle'), true);
  assert.equal(calls.includes('flush'), false);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'automatic-trades'), false);
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'notification-dispatch'), ['notification-dispatch', false]);
  assert.equal(result.batchSize, 2);
  assert.equal(result.source, 'fixture');
  assert.deepEqual(result.rows.find(row => row.symbol === 'BTCUSDT'), {
    symbol: 'BTCUSDT', status: 'WAIT', side: 'WAIT', candleCloseAt: '2026-11-21T09:44:59.999Z',
    reason: 'Volume below minimum', setup: null,
  });
  assert.equal(result.rows.find(row => row.symbol === 'ETHUSDT').status, 'DATA_UNAVAILABLE');
});

test('scheduled scans preserve the existing automatic-trade processing default', async () => {
  calls.length = 0;
  await runSignalScan('15m');

  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'automatic-trades'), [
    'automatic-trades',
    ['signal-1'],
  ]);
});
