import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let admin = { id: 9, role: 'admin' };
let csrfValid = true;
let serviceCalls = [];
class MockAuthError extends Error {}
const service = {
  async createSession(...args) {
    serviceCalls.push(['createSession', ...args]);
    return { id: '9001', status: 'CREATED' };
  },
  async execute(...args) {
    serviceCalls.push(['execute', ...args]);
    return { id: '9001', status: 'RUNNING' };
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request.endsWith('/lib/auth')) {
    return {
      AuthError: MockAuthError,
      async requireAdmin() {
        if (!admin) throw new MockAuthError('Forbidden');
        return admin;
      },
    };
  }
  if (request.endsWith('/lib/http')) return { validCsrf: () => csrfValid };
  if (request.endsWith('/lib/admin-demo-api')) {
    return {
      noStoreJson: (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
      adminDemoApiError: () => ({ error: 'Forbidden.', status: 403 }),
    };
  }
  if (request.endsWith('/lib/admin-demo-execution-service')) {
    return { createProductionAdminDemoExecutionService: async () => service };
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

const sessionsRoute = require('../app/api/admin/binance/demo-testing/sessions/route.ts');
const executionsRoute = require('../app/api/admin/binance/demo-testing/executions/route.ts');

function request(body, url = 'http://localhost/api/admin/binance/demo-testing') {
  return { url, async json() { return body; } };
}

test('session route verifies CSRF and admin identity before calling the service', async () => {
  serviceCalls = [];
  admin = { id: 9, role: 'admin' };
  csrfValid = true;
  const response = await sessionsRoute.POST(request({ symbol: 'BTCUSDT', direction: 'LONG' }));
  assert.equal(response.status, 201);
  assert.deepEqual(serviceCalls[0], ['createSession', admin, { symbol: 'BTCUSDT', direction: 'LONG' }]);

  serviceCalls = [];
  csrfValid = false;
  const blocked = await sessionsRoute.POST(request({ symbol: 'BTCUSDT', direction: 'LONG' }));
  assert.equal(blocked.status, 403);
  assert.equal(serviceCalls.length, 0);

  csrfValid = true;
  admin = null;
  const denied = await sessionsRoute.POST(request({ symbol: 'BTCUSDT', direction: 'LONG' }));
  assert.equal(denied.status, 403);
  assert.equal(serviceCalls.length, 0);
});

test('execution route validates explicit confirmation and never trusts an actor from request data', async () => {
  serviceCalls = [];
  admin = { id: 9, role: 'admin' };
  csrfValid = true;
  const body = {
    sessionId: '9001',
    authorizationId: '77',
    idempotencyKey: 'attempt-1',
    confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
    config: {
      symbol: 'BTCUSDT',
      direction: 'SHORT',
      quantity: '0.1',
      entryPrice: '100',
      stopPrice: '110',
      tp1Price: '90',
      tp2Price: '80',
      tp3Price: '70',
      tickSize: '0.1',
    },
  };
  const response = await executionsRoute.POST(request(body));
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal(serviceCalls[0][0], 'execute');
  assert.deepEqual(serviceCalls[0][1], admin);
  assert.equal(serviceCalls[0][2].adminUserId, undefined);
  assert.equal(serviceCalls[0][2].confirmation, 'RUN_BINANCE_DEMO_LIFECYCLE');

  serviceCalls = [];
  const invalid = await executionsRoute.POST(request({ ...body, adminUserId: 1 }));
  assert.equal(invalid.status, 422);
  assert.equal(serviceCalls.length, 0);

  const wrongConfirmation = await executionsRoute.POST(request({ ...body, confirmation: 'RUN_LIVE' }));
  assert.equal(wrongConfirmation.status, 422);
  assert.equal(serviceCalls.length, 0);
});
