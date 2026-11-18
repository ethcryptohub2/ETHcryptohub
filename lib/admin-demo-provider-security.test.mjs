import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
let admin = { id: 9, role: 'admin', is_active: 1 };
let mutationResponse = null;
class MockAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === './auth' && parent?.filename.endsWith('admin-demo-provider-security.ts')) {
    return {
      AuthError: MockAuthError,
      async requireAdmin() {
        return admin;
      },
    };
  }
  if (request === './http' && parent?.filename.endsWith('admin-demo-provider-security.ts')) {
    return { guardedPost: () => mutationResponse };
  }
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

const security = require('./admin-demo-provider-security.ts');

test('provider actor assertion rejects non-admin and inactive users', async () => {
  assert.throws(
    () => security.assertAdminDemoProviderActor({ id: 9, role: 'user', is_active: 1 }),
    (error) => error instanceof MockAuthError && error.status === 403,
  );
  assert.throws(
    () => security.assertAdminDemoProviderActor({ id: 9, role: 'admin', is_active: 0 }),
    (error) => error instanceof MockAuthError && error.status === 403,
  );

  admin = { id: 9, role: 'admin', is_active: 1 };
  assert.equal((await security.requireAdminDemoAdmin()).id, 9);
});

test('provider/environment assertion enforces the fixed environment', () => {
  assert.deepEqual(
    security.assertAdminDemoProviderEnvironment('GATE', 'TESTNET'),
    { provider: 'GATE', environment: 'TESTNET' },
  );
  assert.throws(
    () => security.assertAdminDemoProviderEnvironment('BYBIT', 'TESTNET'),
    (error) => error.status === 400,
  );
  assert.throws(
    () => security.assertAdminDemoProviderEnvironment('UNKNOWN', 'DEMO'),
    (error) => error.status === 400,
  );
});

test('mutation guard delegates CSRF rejection to the existing guarded-post helper', () => {
  mutationResponse = new Response('forbidden', { status: 403 });
  assert.equal(security.guardAdminDemoProviderMutation({}), mutationResponse);
  mutationResponse = null;
  assert.equal(security.guardAdminDemoProviderMutation({}), null);
});

test('execution and reconciliation capabilities fail closed when unavailable', () => {
  assert.throws(
    () => security.assertAdminDemoProviderCapability({ marketEntry: false }, 'marketEntry'),
    (error) => error.status === 503,
  );
  assert.throws(
    () => security.requireAdminDemoExecutionCapabilities({}, 'MARKET'),
    (error) => error.status === 503,
  );
  assert.throws(
    () => security.requireAdminDemoReconciliationCapability({ adminLifecycle: true }),
    (error) => error.status === 503,
  );
});

test('execution confirmation must exactly match the expected explicit confirmation', () => {
  assert.throws(
    () => security.requireAdminDemoExecutionConfirmation('RUN_LIVE', 'RUN_DEMO'),
    (error) => error.status === 422,
  );
  assert.throws(
    () => security.requireAdminDemoExecutionConfirmation(undefined, 'RUN_DEMO'),
    (error) => error.status === 422,
  );
  assert.doesNotThrow(
    () => security.requireAdminDemoExecutionConfirmation('RUN_DEMO', 'RUN_DEMO'),
  );
});

test('reconciliation renewal is limited to RECONCILE on an active existing session', () => {
  assert.deepEqual(
    security.requireAdminDemoReconciliationRenewal({
      id: 'session-1',
      status: 'RECONCILIATION_REQUIRED',
    }),
    ['RECONCILE'],
  );
  assert.throws(
    () => security.requireAdminDemoReconciliationRenewal(
      { id: 'session-1', status: 'RUNNING' },
      ['RECONCILE', 'START_TEST'],
    ),
    (error) => error.status === 403,
  );
  assert.throws(
    () => security.requireAdminDemoReconciliationRenewal({ id: 'session-1', status: 'PASSED' }),
    (error) => error.status === 409,
  );
});
