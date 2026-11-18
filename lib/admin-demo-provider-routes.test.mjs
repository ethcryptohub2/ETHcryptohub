import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const libDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(libDirectory, '..');
const routesDirectory = path.join(repositoryRoot, 'app', 'api', 'admin', 'demo', 'providers');

function loadTypeScript(sourcePath, stubs = new Map()) {
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const sourceModule = new Module(sourcePath);
  sourceModule.filename = sourcePath;
  sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === sourcePath && stubs.has(request)) return stubs.get(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    sourceModule._compile(compiled.outputText, sourcePath);
    return sourceModule.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const providerContract = loadTypeScript(path.join(libDirectory, 'admin-demo-provider-contract.ts'));
class TestAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class TestProviderSecurityError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let adminError = null;
const serviceCalls = [];
const service = {
  preflight: async (_admin, provider, input) => {
    serviceCalls.push(['preflight', provider, input]);
    return { provider, input, executionReady: false };
  },
  createAuthorization: async (_admin, provider, sessionId, ttl) => {
    serviceCalls.push(['createAuthorization', provider, sessionId, ttl]);
    return { id: 'auth-1' };
  },
  renewReconciliationAuthorization: async (_admin, provider, sessionId, authorizationId, ttl) => {
    serviceCalls.push(['renewReconciliationAuthorization', provider, sessionId, authorizationId, ttl]);
    return { id: authorizationId };
  },
  reconcile: async (_admin, provider, sessionId, authorizationId) => {
    serviceCalls.push(['reconcile', provider, sessionId, authorizationId]);
    throw new Error('apiSecret=must-not-be-logged-or-returned');
  },
  execute: async (_admin, provider, input) => {
    serviceCalls.push(['execute', provider, input]);
    throw new TestProviderSecurityError('Admin Demo capability "adminLifecycle" is unavailable.', 503);
  },
};

const helperPath = path.join(routesDirectory, '_shared.ts');
const shared = loadTypeScript(helperPath, new Map([
  ['../../../../../lib/auth', {
    AuthError: TestAuthError,
    requireAdmin: async () => {
      if (adminError) throw adminError;
      return { id: 17, role: 'admin', is_active: 1 };
    },
  }],
  ['../../../../../lib/admin-demo-provider-service', {
    createServerAdminDemoProviderService: () => service,
  }],
  ['../../../../../lib/admin-demo-provider-contract', providerContract],
  ['../../../../../lib/admin-demo-provider-security', {
    AdminDemoProviderSecurityError: TestProviderSecurityError,
    assertAdminDemoProviderActor: (actor) => {
      if (!actor || actor.role !== 'admin' || actor.is_active !== 1) {
        throw new TestAuthError(403, 'Administrator access is required.');
      }
    },
    assertAdminDemoProviderEnvironment: (provider, environment) => {
      try {
        providerContract.assertAdminDemoProviderEnvironment(provider, environment);
      } catch {
        throw new TestProviderSecurityError(
          'Admin Demo provider environment does not match the fixed provider configuration.',
          400,
        );
      }
    },
    guardAdminDemoProviderMutation: (request) => request.headers.get('x-csrf-token') === 'valid'
      ? null
      : Response.json({ error: 'CSRF denied.' }, { status: 403 }),
  }],
]));

function loadRoute(relativePath) {
  return loadTypeScript(path.join(routesDirectory, relativePath), new Map([
    ['../../_shared', shared],
  ]));
}

const preflightRoute = loadRoute(path.join('[provider]', 'preflight', 'route.ts'));
const authorizationRoute = loadRoute(path.join('[provider]', 'authorization', 'route.ts'));
const reconcileRoute = loadRoute(path.join('[provider]', 'reconcile', 'route.ts'));
const executionRoute = loadRoute(path.join('[provider]', 'executions', 'route.ts'));

function postRequest(pathname, body, csrf = true) {
  return new Request(`https://admin.example${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { 'x-csrf-token': 'valid' } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

test('preflight accepts exactly the UI plan fields and remains read-only', async () => {
  serviceCalls.length = 0;
  const config = {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '0.001',
    entryPrice: '50000',
    stopLoss: '49000',
    tp1Price: '51000',
    tp2Price: '52000',
    tp3Price: '53000',
    tickSize: '0.1',
  };
  const result = await preflightRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/preflight', {
      config,
      environment: 'DEMO',
    }),
    { params: Promise.resolve({ provider: 'BINANCE' }) },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(serviceCalls, [['preflight', 'BINANCE', config]]);
  assert.equal((await result.json()).data.executionReady, false);

  const invalid = await preflightRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/preflight', {
      config: { ...config, orderType: 'MARKET' },
      environment: 'DEMO',
    }),
    { params: Promise.resolve({ provider: 'BINANCE' }) },
  );
  assert.equal(invalid.status, 422);
  assert.equal(serviceCalls.length, 1);
});

test('authorization requires a valid sessionId and enforces admin, CSRF, provider and environment guards', async () => {
  serviceCalls.length = 0;
  const routeContext = { params: Promise.resolve({ provider: 'BINANCE' }) };
  const valid = await authorizationRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/authorization', {
      action: 'create',
      sessionId: 'session_1',
      environment: 'DEMO',
    }),
    routeContext,
  );
  assert.equal(valid.status, 201);
  assert.deepEqual(serviceCalls, [['createAuthorization', 'BINANCE', 'session_1', 300]]);

  const missingSession = await authorizationRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/authorization', {
      action: 'create',
      environment: 'DEMO',
    }),
    routeContext,
  );
  assert.equal(missingSession.status, 422);
  assert.equal(serviceCalls.length, 1);

  const badEnvironment = await authorizationRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/authorization', {
      action: 'create',
      sessionId: 'session_2',
      environment: 'TESTNET',
    }),
    routeContext,
  );
  assert.equal(badEnvironment.status, 400);
  assert.equal(serviceCalls.length, 1);

  const badProvider = await authorizationRoute.POST(
    postRequest('/api/admin/demo/providers/UNKNOWN/authorization', {
      action: 'create',
      sessionId: 'session_2',
    }),
    { params: Promise.resolve({ provider: 'UNKNOWN' }) },
  );
  assert.equal(badProvider.status, 400);

  const badCsrf = await authorizationRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/authorization', {
      action: 'create',
      sessionId: 'session_2',
    }, false),
    routeContext,
  );
  assert.equal(badCsrf.status, 403);
  assert.equal(serviceCalls.length, 1);

  adminError = new TestAuthError(403, 'Administrator access is required.');
  try {
    const forbidden = await authorizationRoute.POST(
      postRequest('/api/admin/demo/providers/BINANCE/authorization', {
        action: 'create',
        sessionId: 'session_3',
      }),
      routeContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(serviceCalls.length, 1);
  } finally {
    adminError = null;
  }
});

test('reconciliation requires both identifiers and service failures are not success-shaped or leaked', async () => {
  serviceCalls.length = 0;
  const context = { params: Promise.resolve({ provider: 'BINANCE' }) };
  const missingAuthorization = await reconcileRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/reconcile', {
      sessionId: '501',
      environment: 'DEMO',
    }),
    context,
  );
  assert.equal(missingAuthorization.status, 422);
  assert.equal(serviceCalls.length, 0);

  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values.join(' '));
  try {
    const failed = await reconcileRoute.POST(
        postRequest('/api/admin/demo/providers/BYBIT/reconcile', {
          sessionId: '501',
          authorizationId: '701',
        environment: 'DEMO',
      }),
        { params: Promise.resolve({ provider: 'BYBIT' }) },
    );
    const response = await responseJson(failed);
    assert.equal(response.status, 503);
    assert.equal(response.body.data, undefined);
    assert.equal(response.body.error, 'Admin Demo provider action is unavailable.');
    assert.deepEqual(serviceCalls, [
      ['reconcile', 'BYBIT', '501', '701'],
    ]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Unexpected Admin Demo provider route failure \(Error\)/);
    assert.doesNotMatch(logs[0], /must-not-be-logged-or-returned/);
    assert.doesNotMatch(JSON.stringify(response.body), /must-not-be-logged-or-returned/);
  } finally {
    console.error = originalError;
  }
});

test('execution contract requires explicit confirmation, Admin authorization and CSRF, then remains blocked', async () => {
  serviceCalls.length = 0;
  const context = { params: Promise.resolve({ provider: 'BYBIT' }) };
  const body = {
    sessionId: '501',
    authorizationId: '701',
    idempotencyKey: 'bybit-test-501',
    confirmation: 'PLACE_ADMIN_DEMO_ORDER',
    entryOrderType: 'LIMIT',
    config: {
      symbol: 'BTCUSDT',
      direction: 'LONG',
      quantity: '0.01',
      entryPrice: '1000',
      stopLoss: '900',
      tp1Price: '1100',
      tp2Price: '1200',
      tp3Price: '1300',
      tickSize: '0.1',
    },
    environment: 'DEMO',
  };
  const blocked = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BYBIT/executions', body),
    context,
  );
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), {
    error: 'Admin Demo capability "adminLifecycle" is unavailable.',
  });
  assert.deepEqual(serviceCalls, [['execute', 'BYBIT', body]]);

  const nonBybit = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BINANCE/executions', body),
    { params: Promise.resolve({ provider: 'BINANCE' }) },
  );
  assert.equal(nonBybit.status, 422);
  assert.equal(serviceCalls.length, 1);

  const wrongEnvironment = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BYBIT/executions', {
      ...body,
      environment: 'TESTNET',
    }),
    context,
  );
  assert.equal(wrongEnvironment.status, 400);
  assert.equal(serviceCalls.length, 1);

  const nonBybitReconcile = await reconcileRoute.POST(
    postRequest('/api/admin/demo/providers/OKX/reconcile', {
      sessionId: '501',
      authorizationId: '701',
      environment: 'DEMO',
    }),
    { params: Promise.resolve({ provider: 'OKX' }) },
  );
  assert.equal(nonBybitReconcile.status, 422);
  assert.equal(serviceCalls.length, 1);

  const invalidConfirmation = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BYBIT/executions', {
      ...body,
      confirmation: 'CONFIRM',
    }),
    context,
  );
  assert.equal(invalidConfirmation.status, 422);
  assert.equal(serviceCalls.length, 1);

  const invalidMode = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BYBIT/executions', {
      ...body,
      executionMode: 'AUTOMATIC',
    }),
    context,
  );
  assert.equal(invalidMode.status, 422);
  assert.equal(serviceCalls.length, 1);

  const rejectedCsrf = await executionRoute.POST(
    postRequest('/api/admin/demo/providers/BYBIT/executions', body, false),
    context,
  );
  assert.equal(rejectedCsrf.status, 403);
  assert.equal(serviceCalls.length, 1);

  adminError = new TestAuthError(403, 'Administrator access is required.');
  try {
    const forbidden = await executionRoute.POST(
      postRequest('/api/admin/demo/providers/BYBIT/executions', body),
      context,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(serviceCalls.length, 1);
  } finally {
    adminError = null;
  }
});
