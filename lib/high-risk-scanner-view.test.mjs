import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function load(file, mocks = {}) {
  const absolute = path.resolve(file);
  const fixture = new Module(absolute);
  fixture.filename = absolute;
  fixture.paths = Module._nodeModulePaths(path.dirname(absolute));
  const realRequire = fixture.require.bind(fixture);
  fixture.require = (name) => name in mocks ? mocks[name] : realRequire(name);
  fixture._compile(ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, absolute);
  return fixture.exports;
}

test('High-Risk view reads scoped saved signals, preserves unavailable TP3 and classifies expired entries', async () => {
  const statements = [];
  const now = Date.now();
  const entry = {
    id: '1', signal_key: 'synthetic', symbol: 'BTCUSDT', timeframe: '15m', side: 'LONG',
    setup_score: 88, entry_price: '100', entry_zone_low: '99', entry_zone_high: '101',
    initial_stop: '90', tp1: '110', tp2: '115', tp3: null, last_price: '102',
    generated_at: new Date(now - 60_000).toISOString(),
    entry_expires_at: new Date(now + 60_000).toISOString(),
    expires_at: new Date(now + 120_000).toISOString(), lifecycle_status: 'ACTIVE',
    setup_context: {}, user_state: null,
  };
  const service = load('lib/high-risk-scalping.ts', {
    './db': { query: async (sql, args) => {
      statements.push(sql);
      if (sql.includes('high_risk_scalping_settings')) {
        return { rows: [{ enabled: true, enabled_timeframes: ['15m'] }] };
      }
      assert.match(sql, /WHERE s\.scanner_type = 'HIGH_RISK'/);
      assert.match(sql, /e\.signal_id = s\.id AND e\.user_id = \$1/);
      assert.deepEqual(args, [42]);
      return { rows: [entry, {
        ...entry, id: '2', tp3: '124', entry_expires_at: new Date(now - 10_000).toISOString(),
      }] };
    } },
    './high-risk-scalping-types': load('lib/high-risk-scalping-types.ts'),
    './high-risk-scalping-status': load('lib/high-risk-scalping-status.ts'),
    './notifications': {},
    './signal-lifecycle': {},
    './scanner-coins': {},
    '../smartexit/apps/api/src/services/binance-futures-markets': { BinanceFuturesMarketsService: class {} },
    '../smartexit/apps/api/src/services/market-scanner': {},
  });
  const saved = await service.listHighRiskScalpingSignals(42);
  assert.equal(saved.active[0].lastPrice, 102);
  assert.equal(saved.active[0].tp3, null);
  assert.equal(saved.history[0].tp3, 124);
  assert.equal(saved.entered.length, 0);
  assert.equal(statements.length, 2);
  assert.ok(statements.every((sql) => sql.startsWith('SELECT')));
});
