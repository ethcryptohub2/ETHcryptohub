import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'admin-demo-authorization.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const {
  AdminDemoSchemaNotReadyError,
  assertAdminDemoAuthorization,
  createPersistentAdminDemoAuthorizationRepository,
  requirePersistentAdminDemoAuthorization,
} = sourceModule.exports;

const now = Date.parse('2026-11-11T10:00:00.000Z');
const baseAuthorization = {
  id: '18',
  adminUserId: 7,
  sessionId: '23',
  testAccountId: '4',
  exchange: 'BINANCE',
  environment: 'DEMO',
  status: 'ACTIVE',
  permittedActions: ['START_TEST', 'RECONCILE'],
  expiresAt: '2026-11-11T10:10:00.000Z',
  consumedAt: null,
};
const baseContext = {
  adminUserId: 7,
  sessionId: '23',
  testAccountId: '4',
  authorizationId: '18',
  exchange: 'BINANCE',
  environment: 'DEMO',
  action: 'START_TEST',
};

test('accepts a live authorization scoped to one Admin, test session, account and Demo exchange', () => {
  assert.equal(assertAdminDemoAuthorization(baseAuthorization, baseContext, now), undefined);
});

test('rejects expired, revoked, consumed and out-of-scope authorizations', () => {
  const cases = [
    [{ ...baseAuthorization, expiresAt: '2026-11-11T09:59:59.000Z' }, baseContext],
    [{ ...baseAuthorization, status: 'REVOKED' }, baseContext],
    [{ ...baseAuthorization, consumedAt: '2026-11-11T09:59:00.000Z' }, baseContext],
    [baseAuthorization, { ...baseContext, adminUserId: 8 }],
    [baseAuthorization, { ...baseContext, sessionId: '24' }],
    [baseAuthorization, { ...baseContext, testAccountId: '5' }],
    [baseAuthorization, { ...baseContext, exchange: 'BYBIT' }],
    [baseAuthorization, { ...baseContext, environment: 'LIVE' }],
    [baseAuthorization, { ...baseContext, action: 'PLACE_ARBITRARY_ORDER' }],
  ];
  for (const [authorization, context] of cases) {
    assert.throws(() => assertAdminDemoAuthorization(authorization, context, now), /authorization is invalid/);
  }
});

test('expiry and revocation also deny reconciliation under this temporary authorization', () => {
  const reconcileContext = { ...baseContext, action: 'RECONCILE' };
  assert.equal(
    assertAdminDemoAuthorization(baseAuthorization, reconcileContext, now),
    undefined,
  );
  assert.throws(
    () => assertAdminDemoAuthorization({ ...baseAuthorization, status: 'EXPIRED' }, reconcileContext, now),
    /authorization is invalid/,
  );
  assert.throws(
    () => assertAdminDemoAuthorization(
      { ...baseAuthorization, expiresAt: '2026-11-11T09:59:59.000Z' },
      reconcileContext,
      now,
    ),
    /authorization is invalid/,
  );
});

test('atomic authorization repository admits one concurrent start and rejects replay', async () => {
  let consumed = false;
  const repository = {
    async authorizeAction(context) {
      if (context.action === 'START_TEST') {
        if (consumed) return null;
        consumed = true;
      }
      return {
        ...baseAuthorization,
        consumedAt: context.action === 'START_TEST' ? '2026-11-11T10:00:00.001Z' : baseAuthorization.consumedAt,
      };
    },
  };
  const [first, second] = await Promise.allSettled([
    requirePersistentAdminDemoAuthorization(repository, baseContext, now),
    requirePersistentAdminDemoAuthorization(repository, baseContext, now),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /concurrently consumed/);
});

test('persistent authorization calls the fixed RPC with the exact Admin Demo scope', async () => {
  let call;
  const repository = createPersistentAdminDemoAuthorizationRepository(
    {
      async rpc(name, parameters) {
        call = { name, parameters };
        return { data: true, error: null };
      },
    },
    {
      async getAuthorization(context) {
        assert.deepEqual(context, baseContext);
        return { ...baseAuthorization, consumedAt: '2026-11-11T10:00:00.001Z' };
      },
    },
  );
  const authorization = await requirePersistentAdminDemoAuthorization(repository, baseContext, now);
  assert.equal(authorization.consumedAt, '2026-11-11T10:00:00.001Z');
  assert.deepEqual(call, {
    name: 'authorize_admin_demo_test_action',
    parameters: {
      p_admin_user_id: 7,
      p_session_id: '23',
      p_authorization_id: '18',
      p_action: 'START_TEST',
    },
  });
});

test('persistent authorization denies false RPC results without reading authorization state', async () => {
  let reads = 0;
  const repository = createPersistentAdminDemoAuthorizationRepository(
    { async rpc() { return { data: false, error: null }; } },
    { async getAuthorization() { reads += 1; return baseAuthorization; } },
  );
  await assert.rejects(
    requirePersistentAdminDemoAuthorization(repository, baseContext, now),
    /unavailable, expired, revoked, replayed, or concurrently consumed/,
  );
  assert.equal(reads, 0);
});

test('persistent authorization reports a missing database function as schema-not-ready', async () => {
  const repository = createPersistentAdminDemoAuthorizationRepository(
    { async rpc() { return { data: null, error: { code: 'PGRST202' } }; } },
    { async getAuthorization() { return baseAuthorization; } },
  );
  await assert.rejects(
    requirePersistentAdminDemoAuthorization(repository, baseContext, now),
    AdminDemoSchemaNotReadyError,
  );
});
