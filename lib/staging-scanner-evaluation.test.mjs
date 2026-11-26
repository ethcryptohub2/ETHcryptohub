import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function load(file, mocks = {}) {
  const absolute = path.resolve(file);
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(path.dirname(absolute));
  const require = mod.require.bind(mod);
  mod.require = key => key in mocks ? mocks[key] : require(key);
  mod._compile(ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, absolute);
  return mod.exports;
}

const binanceRateLimit = load('lib/binance-rate-limit.ts');
const candleCache = load('lib/candle-cache.ts');
const market = load('smartexit/apps/api/src/services/market-scanner.ts', {
  '../../../../../lib/binance-rate-limit': binanceRateLimit,
  '../../../../../lib/candle-cache': candleCache,
});
const highRisk = load('lib/high-risk-scalping.ts', {
  './binance-rate-limit': binanceRateLimit,
  './db': {}, './scanner-coins': {}, './signal-lifecycle': {}, './notifications': {},
  './high-risk-scalping-types': load('lib/high-risk-scalping-types.ts'),
  './high-risk-scalping-status': {},
  '../smartexit/apps/api/src/services/market-scanner': market,
  '../smartexit/apps/api/src/services/binance-futures-markets': { BinanceFuturesMarketsService: class {} },
});
const evaluation = load('lib/staging-scanner-evaluation.ts', {
  '../smartexit/apps/api/src/services/market-scanner': market, './high-risk-scalping': highRisk,
});
const historical = load('lib/backtesting-qualification.ts', {
  '../smartexit/apps/api/src/services/market-scanner': market, './high-risk-scalping': highRisk,
});

test('historical qualification uses existing strategies and refuses future context and candle gaps', async () => {
  const settings = { enabled: true, enabledTimeframes: ['5m'], minimumQuoteVolume: 50_000_000 };
  const base = { asOf: 1_800_000_000_000, eligibleAt: 0, eligibleUntil: null,
    minimumStandardScore: 60, highRiskSettings: settings };
  const symbol = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    contractType: 'PERPETUAL', lastPrice: 100, priceChangePercent24h: 0, quoteVolume24h: 40_000_000, tradeCount24h: 2000 };
  const snapshot = { exchange: 'BINANCE', market: 'USDⓈ-M FUTURES', source: 'synthetic',
    updatedAt: new Date(base.asOf).toISOString(), symbols: [symbol] };
  function candles(size) {
    return Array.from({ length: 201 }, (_, index) => {
      const open = base.asOf + (index - 200) * size;
      return [open, '100', '102', '98', '100', '50', open + size - 1];
    });
  }
  const standard = { ...base, market: snapshot, strategy: 'STANDARD', timeframe: '15m', candles: candles(900_000) };
  assert.equal((await historical.qualifyHistoricalSignal(standard)).candidate.symbol, 'BTCUSDT');
  await assert.rejects(historical.qualifyHistoricalSignal({ ...standard, candles: standard.candles.slice(1) }), /contiguous/);
  const risk = { ...base, market: snapshot, strategy: 'HIGH_RISK', timeframe: '5m',
    candles: candles(300_000), btcContext: { observedAt: base.asOf, changePercent: 0 } };
  assert.equal((await historical.qualifyHistoricalSignal(risk)).setup, null);
  await assert.rejects(historical.qualifyHistoricalSignal({ ...risk,
    btcContext: { ...risk.btcContext, observedAt: base.asOf + 1 } }), /BTC context/);
});
const interval = 300_000;
const boundary = Math.floor(1_800_000_001_000 / interval) * interval;
const now = boundary + 1000;
const tickers = ['BTCUSDT', 'ETHUSDT'].map(symbol => ({ symbol, lastPrice: '100', priceChangePercent: '0',
  quoteVolume: '40000000', count: 1500, closeTime: now - 200 }));
const series = Array.from({ length: 210 }, (_, index) => {
  const open = boundary + (index - 209) * interval;
  return [open, '100', '102', '98', String(100 + Math.sin(index)), '50', open + interval - 1];
});

function options(request) {
  return { symbols: ['BTCUSDT', 'ETHUSDT'], minimumScore: 100,
    highRisk: { ...highRisk.defaultHighRiskScalpingSettings(), enabled: true, minimumSetupScore: 100 },
    request, signal: new AbortController().signal, now: () => now };
}

function response(data) {
  return Response.json(data, { headers: { 'x-mbx-used-weight-1m': '46' } });
}

test('one fresh public candle batch drives both real strategy engines without storage', async () => {
  const requests = [];
  const result = await evaluation.evaluateStagingScanner(options(async (url, init) => {
    requests.push(url);
    assert.equal(url.origin, 'https://fapi.binance.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    return response(url.pathname.endsWith('/24hr') ? tickers : series);
  }));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1).map(url => Object.fromEntries(url.searchParams)), [
    { symbol: 'BTCUSDT', interval: '5m', limit: '400' },
    { symbol: 'ETHUSDT', interval: '5m', limit: '400' },
  ]);
  assert.equal(result.completed, 2);
  assert.equal(result.rows[0].candleCloseAt, new Date(boundary - 1).toISOString());
  assert.deepEqual(result.rows.map(row => [row.standard.status, row.highRisk.status]),
    [['WAIT', 'WAIT'], ['WAIT', 'WAIT']]);
});

test('provider denial stops the batch without retry or the next symbol request', async () => {
  for (const [status, code] of [[403, 'PROVIDER_DENIED'], [418, 'PROVIDER_RATE_LIMIT'],
    [429, 'PROVIDER_RATE_LIMIT'], [451, 'PROVIDER_REGION_RESTRICTION']]) {
    let calls = 0;
    await assert.rejects(evaluation.evaluateStagingScanner(options(async () =>
      ++calls === 1 ? response(tickers) : new Response(null, { status }))),
    error => error.code === code && error.providerStatus === status);
    assert.equal(calls, 2);
  }
});

test('pilot stop before the next request prevents all remaining acquisition', async () => {
  let requests = 0;
  let checks = 0;
  await assert.rejects(evaluation.evaluateStagingScanner({
    ...options(async () => { requests++; return response(tickers); }),
    beforeProviderRequest: async () => {
      if (++checks === 2) throw new evaluation.ScannerEvaluationFailure('PILOT_STOP_SWITCH');
    },
  }), error => error.code === 'PILOT_STOP_SWITCH');
  assert.equal(requests, 1);
  assert.equal(checks, 2);
});

test('reports a fixture-qualified Standard setup with directional protection levels', async () => {
  const trend = series.map(([open, , , , , volume, close], index) => {
    const price = 100 + index / 5;
    return [open, String(price), String(price + 0.25), String(price - 0.25), String(price),
      index === 208 ? '150' : volume, close];
  });
  const tickerRows = tickers.map(row => ({ ...row, lastPrice: '142', priceChangePercent: '2' }));
  const result = await evaluation.evaluateStagingScanner({
    ...options(async url => response(url.pathname.endsWith('/24hr') ? tickerRows : trend)), minimumScore: 60,
  });
  const standard = result.rows[0].standard;
  assert.equal(standard.status, 'QUALIFIED');
  const { initialStop, entryPrice, tp1, tp2, tp3 } = standard.setup;
  assert.ok(initialStop < entryPrice && entryPrice < tp1 && tp1 < tp2 && tp2 < tp3);
});

test('reports a fixture-qualified High-Risk breakout with its own target structure', async () => {
  const history = series.slice(0, 209).map(([open, , , , , , close], index) => {
    const price = 100 + index * 0.025 + Math.sin(index / 2);
    return [open, String(price), String(price + 0.12), String(price - 0.12), String(price), '50', close];
  });
  const breakout = Math.max(...history.slice(-13, -1).map(row => Number(row[2]))) + 0.2;
  history.at(-1).splice(1, 5, String(breakout - 0.2), String(breakout + 0.04),
    String(breakout - 0.24), String(breakout), '180');
  const tickerRows = tickers.map(row => ({ ...row, lastPrice: String(breakout), priceChangePercent: '1' }));
  const config = options(async url => response(url.pathname.endsWith('/24hr') ? tickerRows : history));
  const result = await evaluation.evaluateStagingScanner({ ...config,
    highRisk: { ...config.highRisk, minimumSetupScore: 75 } });
  const signal = result.rows[0].highRisk;
  assert.equal(signal.status, 'QUALIFIED');
  assert.ok(signal.setup.stop < signal.setup.entryPrice && signal.setup.entryPrice < signal.setup.tp1 &&
    signal.setup.tp1 < signal.setup.tp2);
  const independent = await evaluation.evaluateStagingScanner({ ...config, mode: 'high_risk',
    highRisk: { ...config.highRisk, minimumSetupScore: 75 } });
  assert.equal(independent.rows[0].standard, null);
  assert.deepEqual(independent.rows[0].highRisk, signal);
});

test('fails closed on stale, gapped and unordered candles and exhausted IP budget', async () => {
  for (const [data, code] of [[series.slice(0, -2), 'STALE_OR_INSUFFICIENT_CANDLES'],
    [series.filter((_, i) => i !== 30), 'INVALID_CANDLE_SERIES'],
    [[...series].reverse(), 'INVALID_CANDLE_SERIES']]) {
    await assert.rejects(evaluation.evaluateStagingScanner(options(async url =>
      response(url.pathname.endsWith('/24hr') ? tickers : data))), error => error.code === code);
  }
  await assert.rejects(evaluation.evaluateStagingScanner(options(async () => Response.json(tickers, {
    headers: { 'x-mbx-used-weight-1m': '300' },
  }))), error => error.code === 'PROVIDER_WEIGHT_GUARD');
});

test('Admin route gates traffic, rejects a busy distributed lock and rolls back read-only admission', async t => {
  const host = 'cryptohub-scanner-fixture.vercel.app';
  const sha = 'a'.repeat(40);
  const env = { VERCEL_ENV: 'preview', VERCEL_URL: host, VERCEL_GIT_COMMIT_SHA: sha,
    SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'ghecpkpaxbrvehquhzkr',
    SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'production-fixture',
    NEXT_PUBLIC_SUPABASE_URL: 'https://ghecpkpaxbrvehquhzkr.supabase.co',
    SUPABASE_DB_URL: 'postgresql://fixture@db.ghecpkpaxbrvehquhzkr.supabase.co/postgres',
    SMARTEXIT_SCANNER_EVALUATION_APPROVED_UNTIL: new Date(Date.now() + 60_000).toISOString() };
  for (const [key, value] of Object.entries(env)) {
    const saved = process.env[key];
    process.env[key] = value;
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  const gate = 'SMARTEXIT_SCANNER_EVALUATION_APPROVED_SHA';
  const previous = process.env[gate];
  delete process.env[gate];
  t.after(() => { if (previous === undefined) delete process.env[gate]; else process.env[gate] = previous; });
  const statements = [];
  let allowed = false, csrf = false, acquired = false, evaluations = 0;
  class AuthError extends Error { status = 403; }
  const router = load('app/api/admin/scanner-evaluation/route.ts', {
    'node:timers/promises': { setTimeout: async () => {} },
    '../../../../lib/auth': { AuthError, requireAdmin: async () => { if (!allowed) throw new AuthError(); } },
    '../../../../lib/http': { guardedPost: () => csrf ? null : new Response(null, { status: 403 }) },
    '../../../../lib/admin-demo-staging-policy': load('lib/admin-demo-staging-policy.ts'),
    '../../../../lib/db': { pool: () => ({ connect: async () => ({
      query: async sql => { statements.push(sql); return { rows: [{ acquired }] }; },
      release: () => statements.push('RELEASE'),
    }) }) },
    '../../../../lib/scanner-coins': { getEnabledScannerSymbols: async () => ['BTCUSDT'] },
    '../../../../lib/notifications': { getNotificationSystemSettings: async () => ({ minimumSetupScore: 75 }) },
    '../../../../lib/high-risk-scalping': { getHighRiskScalpingSettings: async () => ({ enabled: true }) },
    '../../../../lib/staging-scanner-evaluation': { ...evaluation, evaluateStagingScanner: async () => {
      evaluations += 1; return { completed: 1 };
    } },
  });
  const send = (hostname = host) => router.POST({
    nextUrl: new URL(`https://${hostname}/api/admin/scanner-evaluation`), signal: new AbortController().signal,
    headers: new Headers({ 'content-length': '23' }), json: async () => ({ symbols: ['BTCUSDT'] }),
  });
  assert.equal((await send()).status, 403);
  csrf = true;
  assert.equal((await send()).status, 403);
  allowed = true;
  assert.equal((await send()).status, 503);
  process.env[gate] = sha;
  assert.equal((await send('other.example')).status, 503);
  assert.deepEqual(statements, []);
  assert.equal((await send()).status, 429);
  assert.equal(evaluations, 0);
  acquired = true;
  assert.equal((await send()).status, 200);
  assert.equal(evaluations, 1);
  process.env.SMARTEXIT_SCANNER_EVALUATION_APPROVED_UNTIL = new Date(Date.now() - 1000).toISOString();
  assert.equal((await send()).status, 503);
  assert.deepEqual(statements, Array.from({ length: 2 }, () => [
    'BEGIN READ ONLY', 'SELECT pg_try_advisory_xact_lock(783121, 501) AS acquired', 'ROLLBACK', 'RELEASE',
  ]).flat());
});
