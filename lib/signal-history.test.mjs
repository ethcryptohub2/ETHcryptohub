import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function load(file, stubs) {
  const filename = path.resolve(file);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const delegate = mod.require.bind(mod);
  mod.require = (key) => Object.hasOwn(stubs, key) ? stubs[key] : delegate(key);
  const source = fs.readFileSync(filename, 'utf8');
  mod._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

function fixture() {
  const queries = [];
  const service = load('lib/signal-history.ts', {
    './db': { query: async (sql, values = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    } },
  });
  return { service, queries };
}

test('signal performance limits personal PnL to the signed-in account', async () => {
  const { queries, service } = fixture();
  const route = load('app/api/signals/performance/route.ts', {
    '../../../../lib/auth': { AuthError: class extends Error {} },
    '../../../../lib/signal-history': service,
    '../../../../lib/subscriptions': {
      requirePremiumUser: async () => ({ user: { id: 42 } }),
      SubscriptionError: class extends Error {},
    },
  });
  const response = await route.GET(new Request('https://staging.example/api/signals/performance?userId=99'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const personalQueries = queries.filter(({ sql }) => sql.includes('FROM public.signal_user_entries'));
  assert.equal(personalQueries.length, 2);
  for (const { sql, values } of personalQueries) {
    assert.match(sql, /WHERE user_id = \$1 AND status = 'CLOSED'/);
    assert.deepEqual(values, [42]);
  }
});

test('Admin and customer counters use recorded target events and time-valid active windows', async () => {
  const { queries, service } = fixture();
  await service.listSignalHistory({ successful: true, page: 1, pageSize: 20 });
  await service.getSignalPerformanceSummary(42);
  await service.getAdminSignalStats();

  const activeQueries = queries.filter(({ sql }) => sql.includes('AS active'));
  assert.equal(activeQueries.length, 3);
  for (const { sql } of activeQueries) {
    assert.match(sql, /s\.generated_at <= statement_timestamp\(\) AND s\.expires_at > statement_timestamp\(\)/);
  }
  const milestoneQueries = queries.filter(({ sql }) =>
    sql.includes('AS successful_targets') || sql.includes('AS target_hit') || sql.includes('WHERE EXISTS'));
  assert.equal(milestoneQueries.length, 6);
  for (const { sql } of milestoneQueries) {
    assert.match(sql, /success_event\.signal_id = s\.id/);
    assert.match(sql, /success_event\.event_type IN \('TP1_HIT', 'TP2_HIT', 'TP3_HIT'\)/);
  }
});
