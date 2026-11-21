import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const filename = path.resolve('lib/alpha-observation-history.ts');
function loadHistory() {
  const calls = [];
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  let changes = 1;
  let role = 'smartexit_alpha_history';
  mod.require = key => ({
    pg: { Pool: class {
      constructor(options) { calls.push(options.ssl); }
      async query(sql, values) {
        calls.push({ sql, values });
        return sql.includes('current_user') ? { rows: [{ role, db: 'postgres' }] } : { rowCount: changes, rows: [] };
      }
      async end() { calls.push('closed'); }
    } },
    './admin-demo-staging-policy': {
      isApprovedAdminDemoStagingTarget: () => true,
      isPreviewMarketRequestApproved: (env, _hostname, operation) => env[operation] === 'approved',
    },
  })[key];
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return { ...mod.exports, calls, replay: () => { changes = 0; }, wrongRole: () => { role = 'unexpected'; } };
}

const target = 'alpha-preview.example';
const project = 'ghecpkpaxbrvehquhzkr';
const dedicatedUrl = new URL(`postgresql://db.${project}.supabase.co/postgres`);
dedicatedUrl.username = 'smartexit_alpha_history';
dedicatedUrl.password = 'offline-fixture';
const env = {
  VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'functional-staging', VERCEL_URL: target,
  SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: project, SMARTEXIT_ALPHA_HISTORY_DB_URL: dedicatedUrl.href,
  ALPHA_INTELLIGENCE: 'approved', ALPHA_HISTORY_WRITE: 'approved',
};

test('archive admits only verified observations for the approved IDs and preserves replay idempotency', async () => {
  const history = loadHistory();
  const now = Date.now();
  const at = offset => new Date(now + offset).toISOString();
  const row = { id: 'ALPHA_1', chain: 'Fixture', contract: '0xfake', market: 'ALPHA_1USDT', price: 7,
    verifiedAt: at(-1000), sourceLinks: ['https://developers.binance.com'], signalStatus: 'OBSERVATION_ONLY' };
  const snapshot = { checkedAt: at(0), sources: [], rows: [
    row, { ...row, id: 'ALPHA_2', verifiedAt: at(-61_000) }, { ...row, id: 'ALPHA_3' },
  ] };
  const signal = new AbortController().signal;
  assert.equal(await history.storeApprovedAlphaObservations({ ...env, ALPHA_HISTORY_WRITE: '' }, target, ['ALPHA_1'], snapshot, signal), 'DISABLED');
  assert.equal(await history.storeApprovedAlphaObservations({ ...env, VERCEL_ENV: 'production' }, target, ['ALPHA_1'], snapshot, signal), 'UNAVAILABLE');
  assert.deepEqual(history.calls, []);
  assert.equal(await history.storeApprovedAlphaObservations(env, target, ['ALPHA_1', 'ALPHA_2'], snapshot, signal), 'STORED');
  assert.deepEqual(history.calls[0], { rejectUnauthorized: true, servername: `db.${project}.supabase.co` });
  assert.match(history.calls[2].sql, /ON CONFLICT.*DO NOTHING/);
  const saved = JSON.parse(history.calls[2].values[0]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].alpha_id, 'ALPHA_1');
  assert.equal(saved[0].measurements.signalStatus, 'OBSERVATION_ONLY');
  history.replay();
  assert.equal(await history.storeApprovedAlphaObservations(env, target, ['ALPHA_1'], snapshot, signal), 'ALREADY_RECORDED');
});

test('archive reads remain disabled by default and reject a mismatched database role', async () => {
  const history = loadHistory();
  assert.equal(await history.readAlphaObservationHistory(env, target), null);
  assert.deepEqual(history.calls, []);
  const read = { ...env, SMARTEXIT_ALPHA_HISTORY_READ_ENABLED: 'true' };
  assert.deepEqual(await history.readAlphaObservationHistory(read, target), []);
  assert.match(history.calls[2].sql, /ORDER BY collected_at DESC.*LIMIT 25/);
  history.wrongRole();
  await assert.rejects(history.readAlphaObservationHistory(read, target), /identity mismatch/);
  assert.equal(history.calls.at(-1), 'closed');
});
