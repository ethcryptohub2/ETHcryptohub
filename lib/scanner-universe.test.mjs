import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
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

function fixture(overrides = {}) {
  const reads = [];
  const entitlementOptions = [];
  const authError = class extends Error { status = 401; };
  const route = load('app/api/scanner/route.ts', {
    '../../../lib/auth': { AuthError: authError },
    '../../../lib/subscriptions': { requirePremiumUser: async (options) => {
      entitlementOptions.push(options);
      if (overrides.authFails) throw new authError('Sign in is required.');
    }, SubscriptionError: class extends Error {} },
    '../../../smartexit/apps/api/src/schemas': load('smartexit/apps/api/src/schemas.ts'),
    '../../../smartexit/apps/api/src/services/market-scanner': { recommendedMaxAgeSeconds: () => 1800 },
    '../../../lib/scanner-snapshot': load('lib/scanner-snapshot.ts'),
    '../../../lib/scanner-universe': load('lib/scanner-universe.ts'),
    '../../../lib/notifications': {
      defaultNotificationSystemSettings: () => ({ minimumSetupScore: 60 }),
      getNotificationSystemSettings: async () => {
        if (overrides.settingsFails) throw new Error('Fixture settings error');
        return { minimumSetupScore: 60 };
      },
      getPersistedSignalMetadata: async () => {
        if (overrides.metadataFails) throw new Error('Fixture catalog error');
        return overrides.metadata ?? {};
      },
      signalKeyForCandidate: () => 'fixture-key',
    },
    '../../../lib/scanner-coins': { getSavedScannerUniverse: async (input) => {
      reads.push(input);
      if (overrides.dbFails) throw new Error('remote schema stack must stay server-side');
      return { eligible_count: 522, saved_count: 0, recent_until: [], watchlist_count: 20, latest_saved_at: null, universe_synced_at: null,
        rows: [], matching_count: 0, ...overrides.result };
    } },
  });
  return { reads, entitlementOptions, get: (search = '') => route.GET(new NextRequest(`https://staging.example/api/scanner${search}`)) };
}

test('scanner browse keeps saved coverage separate from eligible instruments and bounds filters', async () => {
  const { get, reads, entitlementOptions } = fixture({ result: {
    matching_count: 2,
    rows: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', eligible: true, watchlist: true, savedScanAt: null, candidate: null }],
  } });
  const response = await get('?coverage=eligible&symbol=btc&page=2&limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(entitlementOptions, [{ reconcile: false }]);
  assert.deepEqual(reads[0], { timeframe: '15m', coverage: 'eligible', symbol: 'BTC', rank: null, page: 2, limit: 1, maxAgeSeconds: 1800 });
  const { data } = await response.json();
  assert.equal(data.eligibleCount, 522);
  assert.equal(data.savedCount, 0);
  assert.equal(data.watchlistCount, 20);
  assert.equal(data.matchingCount, 2);
  assert.equal(data.updatedAt, null);
  assert.equal(data.status, 'NO_SAVED_RESULTS');
  assert.deepEqual(data.candidates, []);
  assert.equal(data.instruments[0].watchlist, true);
  for (const invalid of ['?coverage=eligible&rank=TOP_VOLUME', '?symbol=BTC%25', '?limit=101', '?page=1001', '?tenantId=2']) {
    assert.equal((await get(invalid)).status, 422);
  }
  assert.equal(reads.length, 1);
});

test('recent coverage is global and requires usable candle evidence even when the newest scan just completed', async () => {
  const latest = new Date(Date.now() - 1000).toISOString();
  const expirations = Array.from({ length: 10 }, () => Date.now() + 600_000);
  const { get } = fixture({ result: { saved_count: 28, latest_saved_at: latest, recent_until: expirations } });
  const { data } = await (await get('?coverage=eligible&symbol=BTC&limit=1')).json();
  assert.equal(data.eligibleCount, 522);
  assert.equal(data.savedCount, 28);
  assert.equal(data.updatedAt, latest);
  assert.equal(data.recentUntil.length, 10);
  assert.equal(data.status, 'RECENT_CACHE');
  const staleResult = fixture({ result: { saved_count: 28, latest_saved_at: latest } });
  assert.equal((await (await staleResult.get()).json()).data.status, 'STALE_CACHE');
});

test('ages cached data at the allowed timeframe bound and withholds setup if lifecycle lookup failed', async () => {
  const stale = new Date(Date.now() - 3_600_000).toISOString();
  const recent = new Date(Date.now() - 1_000).toISOString();
  const candidate = (lastCandleCloseAt) => ({
    symbol: 'BTCUSDT', status: 'READY', side: 'LONG', price: 983, lastCandleCloseAt,
    warnings: [], score: { value: 70 }, setup: { initialStop: 973, entryPrice: 983, tp1: 993, tp2: 1003, tp3: 1013 },
  });
  const instrument = { symbol: 'BTCUSDT', baseAsset: 'BTC', eligible: true, watchlist: true };
  const oldFixture = fixture({ result: {
    saved_count: 1, latest_saved_at: stale, matching_count: 1,
    rows: [{ ...instrument, savedScanAt: stale, candidate: candidate(stale) }],
  } });
  const { data: cached } = await (await oldFixture.get('?maxAgeSeconds=86400')).json();
  assert.equal(cached.configuration.maxAgeSeconds, 1800);
  assert.equal(cached.status, 'STALE_CACHE');
  assert.equal(cached.updatedAt, stale);
  assert.equal(cached.candidates[0].price, null);
  assert.equal(cached.candidates[0].setup, null);
  const recentFixture = fixture({ metadataFails: true, result: {
    saved_count: 1, latest_saved_at: recent, matching_count: 1,
    rows: [{ ...instrument, savedScanAt: recent, candidate: candidate(recent) }],
  } });
  const { data, notificationWarning } = await (await recentFixture.get()).json();
  assert.equal(data.candidates[0].status, 'WAIT');
  assert.equal(data.candidates[0].setup, null);
  assert.match(notificationWarning, /Signal validity could not be verified/);
  const scoreFixture = fixture({ result: {
    saved_count: 1, latest_saved_at: recent, matching_count: 1,
    rows: [{ ...instrument, savedScanAt: recent, candidate: candidate(recent) }],
  } });
  const { data: belowMinimum } = await (await scoreFixture.get('?minimumScore=80')).json();
  assert.equal(belowMinimum.candidates[0].status, 'WAIT');
  assert.equal(belowMinimum.candidates[0].setup, null);
});

test('reveals qualified Standard setup levels only when saved data and qualification policy are valid', async () => {
  const recent = new Date(Date.now() - 1000).toISOString();
  const setup = { initialStop: 105, entryPrice: 100, tp1: 95, tp2: 90, tp3: 85 };
  const candidate = { symbol: 'BTCUSDT', status: 'READY', side: 'SHORT', price: 100, lastCandleCloseAt: recent,
    warnings: [], score: { value: 70 }, setup };
  const result = (saved = candidate) => ({
    saved_count: 1, latest_saved_at: recent, matching_count: 1,
    rows: [{ symbol: 'BTCUSDT', eligible: true, savedScanAt: recent, candidate: saved }],
  });
  const signal = { id: '8', generatedAt: recent, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'ACTIVE', entryZone: { low: 99, high: 101 } };
  const metadata = { 'fixture-key': signal };
  const qualified = await (await fixture({ result: result(), metadata }).get()).json();
  assert.deepEqual(qualified.data.candidates[0].setup, setup);
  assert.deepEqual(qualified.signalMetadata.signals.BTCUSDT.entryZone, signal.entryZone);

  const unknownPolicy = await (await fixture({ result: result(), metadata, settingsFails: true }).get()).json();
  assert.match(unknownPolicy.notificationWarning, /qualification settings could not be checked/);
  assert.equal(unknownPolicy.data.candidates[0].setup, null);

  const invalidLevels = await (await fixture({ result: result({ ...candidate, setup: { ...setup, tp2: 104 } }) }).get()).json();
  assert.equal(invalidLevels.data.candidates[0].status, 'WAIT');
  assert.equal(invalidLevels.data.candidates[0].setup, null);

  const missed = await (await fixture({ result: result(), metadata: { 'fixture-key': { ...signal, status: 'MISSED' } } }).get()).json();
  assert.equal(missed.data.candidates[0].setup, null);
  assert.equal(missed.signalMetadata.signals.BTCUSDT.status, 'MISSED');
});

test('scanner distinguishes unauthenticated calls and sanitized storage availability failures', async () => {
  const guest = fixture({ authFails: true });
  assert.equal((await guest.get()).status, 401);
  assert.equal(guest.reads.length, 0);
  const unavailable = await fixture({ dbFails: true }).get();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: 'Saved scanner data could not be read. Retry the saved results or contact an administrator if it persists.',
  });
});
