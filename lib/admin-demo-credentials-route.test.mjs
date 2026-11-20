import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let adminRequired = 0;
let connectionCount = 0;
let activeSession = false;
let transactionStatements = [];
let statusQueries = [];
class MockAuthError extends Error {}

const client = {
  async query(sql, values) {
    transactionStatements.push({ sql, values });
    if (sql.includes('FROM public.admin_demo_test_sessions')) {
      return { rows: activeSession ? [{ id: '9001' }] : [] };
    }
    if (sql.includes('RETURNING account_id::TEXT')) return { rows: [{ account_id: '44' }] };
    return { rows: [] };
  },
  release() {},
};

Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request.endsWith('/lib/auth')) {
    return {
      AuthError: MockAuthError,
      async requireAdmin() {
        adminRequired += 1;
        return { id: 9, role: 'admin' };
      },
    };
  }
  if (request.endsWith('/lib/binance-credentials')) {
    return { encryptCredential: (value) => `encrypted:${value}` };
  }
  if (request.endsWith('/lib/db')) {
    return {
      pool() {
        return {
          async connect() {
            connectionCount += 1;
            return client;
          },
        };
      },
      async query(sql, values) {
        statusQueries.push({ sql, values });
        return { rows: [] };
      },
    };
  }
  if (request.endsWith('/lib/http')) return { validCsrf: () => true };
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

const route = require('../app/api/admin/binance/demo-testing/route.ts');
const environmentKeys = [
  'SMARTEXIT_ADMIN_BINANCE_DEMO_LAB_ENABLED',
  'VERCEL_ENV',
  'SMARTEXIT_DEPLOYMENT_ENV',
  'SMARTEXIT_STAGING_SUPABASE_PROJECT_REF',
  'SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_DB_URL',
];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

function setStagingEnvironment(vercelEnvironment = 'preview') {
  process.env.SMARTEXIT_ADMIN_BINANCE_DEMO_LAB_ENABLED = 'true';
  process.env.VERCEL_ENV = vercelEnvironment;
  process.env.SMARTEXIT_DEPLOYMENT_ENV = 'staging';
  process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF = 'stage-ref';
  process.env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF = 'prod-ref';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stage-ref.supabase.co';
  process.env.SUPABASE_DB_URL = 'postgresql://postgres.stage-ref@pooler.example:6543/postgres';
}

function resetCalls() {
  adminRequired = 0;
  connectionCount = 0;
  activeSession = false;
  transactionStatements = [];
  statusQueries = [];
}

function post(body) {
  return { async json() { return body; } };
}

test.afterEach(() => {
  resetCalls();
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
});

test('credential status and mutation routes reject Production despite a Staging override', async () => {
  setStagingEnvironment('production');
  const status = await route.GET();
  const mutation = await route.POST(post({ action: 'revokeCredentials' }));
  assert.equal(status.status, 403);
  assert.equal(mutation.status, 403);
  assert.equal(adminRequired, 0);
  assert.equal(connectionCount, 0);
});

test('credential revocation is blocked while any nonterminal test session exists', async () => {
  setStagingEnvironment();
  activeSession = true;
  const response = await route.POST(post({ action: 'revokeCredentials' }));
  assert.equal(response.status, 409);
  assert.match(transactionStatements[1].sql, /pg_advisory_xact_lock\(hashtext\('smart_exit_admin_demo_credentials:'/);
  assert.match(transactionStatements[2].sql, /session_status NOT IN \('PASSED', 'FAILED', 'REVOKED', 'EXPIRED'\)/);
  assert.ok(transactionStatements.some(({ sql }) => sql === 'ROLLBACK'));
  assert.equal(transactionStatements.some(({ sql }) => sql.includes('WITH revoked_account')), false);
});

test('credential updates acquire the shared lock and commit only after active-session check', async () => {
  setStagingEnvironment();
  const response = await route.POST(post({
    action: 'saveCredentials',
    apiKey: 'demo-api-key-123456',
    apiSecret: 'demo-api-secret-123456',
    confirmDemoIssued: true,
  }));
  assert.equal(response.status, 200);
  const lockIndex = transactionStatements.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'));
  const activeCheckIndex = transactionStatements.findIndex(({ sql }) => sql.includes('FROM public.admin_demo_test_sessions'));
  const updateIndex = transactionStatements.findIndex(({ sql }) => sql.includes('WITH saved_account'));
  const commitIndex = transactionStatements.findIndex(({ sql }) => sql === 'COMMIT');
  assert.ok(lockIndex >= 0 && lockIndex < activeCheckIndex);
  assert.ok(activeCheckIndex < updateIndex && updateIndex < commitIndex);
  assert.equal(statusQueries.length, 3);
});
