import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};
Module._extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  module._compile(compiled.outputText, filename);
};

const { createAdminDemoExecutionRepository } = require('./admin-demo-execution-repository.ts');
const scope = {
  kind: 'ADMIN_DEMO_TEST',
  adminUserId: 9,
  sessionId: '9001',
  executionId: '9001',
  testAccountId: '44',
  authorizationId: '77',
  exchange: 'BINANCE',
  environment: 'DEMO',
  strategy: 'STANDARD',
};

test('session reads are isolated to the confirmed Admin Demo account and reject revoked accounts', async () => {
  const calls = [];
  const repository = createAdminDemoExecutionRepository(async (sql, values) => {
    calls.push({ sql, values });
    if (values?.[1] !== 9) return { rows: [] };
    return {
      rows: [{
        id: '9001',
        admin_user_id: 9,
        test_account_id: '44',
        session_status: 'CREATED',
        symbol: 'BTCUSDT',
        direction: 'LONG',
        created_at: '2026-01-01T00:00:00Z',
        authorization_expires_at: null,
        account_revoked_at: null,
      }],
    };
  });

  const session = await repository.getSession(9, '9001');
  assert.equal(session.testAccountId, '44');
  assert.equal(await repository.getSession(8, '9001'), null);
  assert.match(calls[0].sql, /admin_demo_test_sessions/);
  assert.match(calls[0].sql, /admin_binance_demo_test_accounts/);
  assert.match(calls[0].sql, /s\.admin_user_id = \$2/);
  assert.match(calls[0].sql, /s\.environment = 'DEMO'/);
  assert.doesNotMatch(calls[0].sql, /customer.*(?:execution|credential)|trading_positions/i);

  const revokedRepository = createAdminDemoExecutionRepository(async () => ({
    rows: [{
      id: '9001',
      admin_user_id: 9,
      test_account_id: '44',
      session_status: 'CREATED',
      symbol: 'BTCUSDT',
      direction: 'LONG',
      created_at: '2026-01-01T00:00:00Z',
      authorization_expires_at: null,
      account_revoked_at: '2026-01-02T00:00:00Z',
    }],
  }));
  assert.equal(await revokedRepository.getSession(9, '9001'), null);
});

test('session creation shares the credential lock and locks the selected account', async () => {
  let statement = '';
  const repository = createAdminDemoExecutionRepository(async (sql) => {
    statement = sql;
    return {
      rows: [{
        id: '9001',
        admin_user_id: 9,
        test_account_id: '44',
        session_status: 'CREATED',
        symbol: 'BTCUSDT',
        direction: 'LONG',
        created_at: '2026-01-01T00:00:00Z',
        authorization_expires_at: null,
      }],
    };
  });

  const session = await repository.createSession(9, 'BTCUSDT', 'LONG');
  assert.equal(session.status, 'CREATED');
  assert.match(statement, /pg_advisory_xact_lock\(hashtext\('smart_exit_admin_demo_credentials:'/);
  assert.match(statement, /FOR UPDATE OF a/);
});

test('authorization revocation resets a not-yet-run session and writes a scoped audit event', async () => {
  const calls = [];
  const repository = createAdminDemoExecutionRepository(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [{ authorization_id: '77' }] };
  });

  assert.equal(await repository.revokeAuthorization(9, '9001', '77'), true);
  assert.match(calls[0].sql, /session_status = 'CREATED', authorization_expires_at = NULL/);
  assert.match(calls[0].sql, /a\.id = \$1 AND a\.session_id = \$2 AND a\.admin_user_id = \$3/);
  assert.match(calls[0].sql, /AUTHORIZATION_REVOKED/);
  assert.deepEqual(calls[0].values, ['77', '9001', 9]);
});

test('audit details drop secrets, tokens, error messages, and arbitrary free text', async () => {
  let inserted;
  const repository = createAdminDemoExecutionRepository(async (sql, values) => {
    assert.match(sql, /INSERT INTO public\.admin_demo_test_events/);
    inserted = values;
    return { rows: [{ id: '1' }] };
  });

  await repository.appendAudit(scope, 'TEST_FAILED', 'FAILED', {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    environment: 'DEMO',
    apiKey: 'sensitive',
    token: 'sensitive',
    reason: 'sensitive error message',
    message: 'sensitive response text',
    arbitrary: 'untrusted text',
  });

  const storedDetails = JSON.parse(inserted[6]);
  assert.deepEqual(storedDetails, {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    environment: 'DEMO',
  });
  assert.equal(inserted[0], '9001');
  assert.equal(inserted[1], 9);
  assert.equal(inserted[2], '44');
  assert.equal(inserted[3], '77');
});

test('reconciliation lock release fails explicitly if the lock is no longer owned', async () => {
  const calls = [];
  const repository = createAdminDemoExecutionRepository(async (sql, values) => {
    calls.push({ sql, values });
    if (/SET reconcile_lock_token = \$4::UUID/.test(sql)) {
      return { rows: [{ session_id: '9001' }] };
    }
    return { rows: [] };
  });

  const claimScope = { ...scope, executionId: '9001' };
  assert.equal(await repository.reconciliation.claim(claimScope), true);
  await assert.rejects(
    repository.reconciliation.release(claimScope),
    /lock was lost before release/,
  );
  assert.match(calls[1].sql, /reconcile_lock_token = \$4::UUID/);
});
