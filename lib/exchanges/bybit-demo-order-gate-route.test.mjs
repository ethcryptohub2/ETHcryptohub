import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourcePath = path.resolve(
  process.cwd(),
  'app',
  'api',
  'admin',
  'exchanges',
  'testing',
  'route.ts',
);
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});
const routeModule = new Module(sourcePath);
routeModule.filename = sourcePath;
routeModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
const calls = [];
const originalLoad = Module._load;
class MockAuthError extends Error {}
class MockBybitDemoError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

try {
  Module._load = function load(request, parent, isMain) {
    if (request.endsWith('/lib/auth')) {
      return {
        AuthError: MockAuthError,
        async requireAdmin() { return { id: 7, role: 'admin' }; },
      };
    }
    if (request.endsWith('/lib/db')) {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      };
    }
    if (request.endsWith('/lib/http')) return { validCsrf: () => true };
    if (request.endsWith('/lib/exchanges/credentials')) {
      return {
        async getExchangeCredentialStatus() { return {}; },
        async loadExchangeCredentials() { calls.push('credentials-loaded'); return {}; },
        async markExchangeCredentialsVerified() {},
        async removeExchangeCredentials() {},
        async saveExchangeCredentials() {},
      };
    }
    if (request.endsWith('/lib/exchanges/bybit-demo')) {
      return {
        BybitDemoError: MockBybitDemoError,
        createBybitDemoAdapter() { calls.push('adapter-created'); return {}; },
      };
    }
    if (request.endsWith('/lib/exchanges/demo-order-approval')) {
      return {
        isBybitDemoOrderSubmissionEnabled: () => false,
        requiresBybitDemoOrderSubmission: (action) =>
          ['marketOrder', 'limitOrder', 'cancel', 'protection', 'close', 'leverage'].includes(action),
      };
    }
    if (request.endsWith('/lib/exchanges/schema')) {
      return { async assertExchangeFoundationReady() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  routeModule._compile(compiled.outputText, sourcePath);
} finally {
  Module._load = originalLoad;
}

test('Bybit market order is rejected server-side before loading credentials or adapter', async () => {
  calls.length = 0;
  const response = await routeModule.exports.POST({
    async json() {
      return {
        action: 'marketOrder',
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: '0.001',
        confirmDemoOrder: true,
      };
    },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.match(body.error, /disabled until separately authorized/i);
  assert.equal(calls.includes('credentials-loaded'), false);
  assert.equal(calls.includes('adapter-created'), false);
});
