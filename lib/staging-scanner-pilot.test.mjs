import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const filename = path.resolve('lib/staging-scanner-pilot.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const sha = 'a'.repeat(40);
const hostname = 'cryptohub-pilot-fixture.vercel.app';
const token = 't'.repeat(32);
const ref = 'ghecpkpaxbrvehquhzkr';
const db = new URL(`postgresql://smartexit_scanner_pilot@db.${ref}.supabase.co/postgres`);
db.password = 'fixture';
const env = {
  VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'functional-staging', VERCEL_URL: hostname,
  VERCEL_GIT_COMMIT_SHA: sha, NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: ref,
  SMARTEXIT_SCANNER_PILOT_TOKEN: token, SMARTEXIT_SCANNER_PILOT_ENABLED: 'true',
  SMARTEXIT_SCANNER_PILOT_APPROVED_SHA: sha, SMARTEXIT_SCANNER_PILOT_DB_URL: db.href,
  SMARTEXIT_SCANNER_PILOT_START_UTC: '2026-11-21T10:00:00Z',
  SMARTEXIT_SCANNER_PILOT_STOP_UTC: '2026-11-21T11:00:00Z',
  SMARTEXIT_SCANNER_PILOT_SYMBOLS: 'BTCUSDT,ETHUSDT,BNBUSDT',
};
const credentials = { hostname, expectedSha: sha, token };
const now = Date.parse('2026-11-21T10:02:00Z');

function load(mode) {
  const statements = [];
  const modes = new Set(mode ?? []);
  const fixtureModule = new Module(filename);
  fixtureModule.filename = filename;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  class ScannerEvaluationFailure extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const mocks = {
    pg: { Pool: class {
      constructor(config) {
        assert.equal(config.ssl.rejectUnauthorized, true);
        assert.equal(config.ssl.servername, db.hostname);
        statements.push('POOL');
      }
      async connect() {
        return {
          query: async (sql, parameters) => {
            statements.push(sql.split(' ').slice(0, 4).join(' '));
            if (sql.includes('current_user')) return { rows: [{ role: 'smartexit_scanner_pilot', database: 'postgres' }] };
            if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: !modes.has('busy') }] };
            if (sql.includes('FROM public.scanner_pilot_control')) return { rows: [{ stopped: modes.has('stopped') }] };
            if (sql.includes('failure_code = ANY')) return { rowCount: Number(modes.has('latched')) };
            if (sql.startsWith('INSERT')) return { rowCount: Number(!modes.has('duplicate')) };
            if (sql.includes("state = 'FAILED'")) statements.push(parameters[1]);
            if (sql.includes("state = 'COMPLETED'")) assert.equal(JSON.parse(parameters[1]).standardCreated, 1);
            return { rows: [] };
          },
          release: () => statements.push('RELEASE'),
        };
      }
      async end() { statements.push('END'); }
    } },
    './high-risk-scalping': {
      getHighRiskScalpingSettings: async () => ({}),
      insertHighRiskSignal: async () => { statements.push('HIGH_RISK'); return {}; },
    },
    './notifications': {
      getNotificationSystemSettings: async () => ({ minimumSetupScore: 60 }),
      insertSignal: async (_client, row) => {
        statements.push('STANDARD');
        if (modes.has('storage')) throw new Error('synthetic storage fault');
        return row.status === 'READY';
      },
    },
    './scanner-coins': {
      getEnabledScannerSymbols: async () => env.SMARTEXIT_SCANNER_PILOT_SYMBOLS.split(','),
      upsertScannerCandidates: async () => statements.push('SNAPSHOTS'),
    },
    './staging-scanner-evaluation': {
      ScannerEvaluationFailure,
      evaluateStagingScanner: async options => {
        statements.push('PROVIDER');
        if (modes.has('denied')) throw new ScannerEvaluationFailure('PROVIDER_DENIED');
        options.onStandardCandidates([{ status: 'READY' }, { status: 'WAIT' }, { status: 'WAIT' }]);
        return { rows: [{ highRisk: { setup: {} } }, { highRisk: {} }, { highRisk: {} }] };
      },
    },
  };
  const require = fixtureModule.require.bind(fixtureModule);
  fixtureModule.require = key => key in mocks ? mocks[key] : require(key);
  fixtureModule._compile(compiled, filename);
  return { ...fixtureModule.exports, statements };
}

test('pilot admission requires an exact Preview, Staging DB identity, token, window and approved symbols', () => {
  const { getApprovedScannerPilot, statements } = load();
  assert.equal(getApprovedScannerPilot(env, credentials, now).slotAt, '2026-11-21T10:00:00.000Z');
  for (const override of [
    { VERCEL_ENV: 'production' }, { VERCEL_GIT_COMMIT_REF: 'main' }, { SMARTEXIT_SCANNER_PILOT_ENABLED: undefined },
    { SMARTEXIT_SCANNER_PILOT_DB_URL: db.href.replace(ref, 'production') },
    { SMARTEXIT_SCANNER_PILOT_DB_URL: db.href.replace('smartexit_scanner_pilot', 'postgres') },
    { SMARTEXIT_SCANNER_PILOT_SYMBOLS: 'BTCUSDT,BTCUSDT,BNBUSDT' },
    { SMARTEXIT_SCANNER_PILOT_STOP_UTC: '2026-11-21T11:15:00Z' },
  ]) assert.equal(getApprovedScannerPilot({ ...env, ...override }, credentials, now), null);
  assert.equal(getApprovedScannerPilot(env, { ...credentials, token: 'q'.repeat(32) }, now), null);
  assert.equal(getApprovedScannerPilot(env, { ...credentials, expectedSha: null }, now), null);
  assert.equal(getApprovedScannerPilot(env, credentials, Date.parse('2026-11-21T10:05:00Z')), null);
  assert.deepEqual(statements, []);
});

test('pilot holds the shared lock and does not acquire provider data on duplicates, stop latches or overlap', async () => {
  for (const [mode, state] of [['busy', 'BUSY'], ['stopped', 'STOPPED'], ['latched', 'PROVIDER_STOP_LATCHED'], ['duplicate', 'DUPLICATE']]) {
    const { runStagingScannerPilot, getApprovedScannerPilot, statements } = load([mode]);
    const result = await runStagingScannerPilot(getApprovedScannerPilot(env, credentials, now), new AbortController().signal, () => true);
    assert.equal(result.state, state);
    assert.equal(statements.includes('PROVIDER'), false);
    assert.ok(statements.some(sql => sql.includes('pg_try_advisory_xact_lock(783121,')));
    assert.deepEqual(statements.slice(-3), ['ROLLBACK', 'RELEASE', 'END']);
  }
});

test('pilot publishes both strategies atomically and rolls back batch writes on provider or storage failure', async () => {
  for (const [mode, state, code] of [[[], 'COMPLETED', undefined], [['denied'], 'FAILED', 'PROVIDER_DENIED'],
    [['storage'], 'FAILED', 'PILOT_STORAGE_OR_RUNTIME_ERROR']]) {
    const { runStagingScannerPilot, getApprovedScannerPilot, statements } = load(mode);
    const result = await runStagingScannerPilot(getApprovedScannerPilot(env, credentials, now), new AbortController().signal, () => true);
    assert.equal(result.state, state);
    assert.equal(result.failureCode, code);
    assert.equal(statements.filter(item => item === 'COMMIT').length, 1);
    assert.equal(statements.includes('ROLLBACK TO SAVEPOINT scanner_batch'), state === 'FAILED');
    assert.equal(statements.includes('HIGH_RISK'), state === 'COMPLETED');
    if (code) assert.ok(statements.includes(code));
  }
});
