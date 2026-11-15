import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let reconciliationCalls = 0;
Module._load = function (request, parent, isMain) {
  if (request === 'next/server') {
    return {
      NextResponse: {
        json(body, init) {
          return new Response(JSON.stringify(body), init);
        },
      },
    };
  }
  if (request.endsWith('/lib/trading-execution')) {
    return {
      async reconcileBinanceDemoProtection() {
        reconciliationCalls += 1;
        return { checked: 1 };
      },
    };
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

const route = require('../app/api/cron/binance-protection/route.ts');
const environmentKeys = [
  'VERCEL_ENV',
  'SMARTEXIT_DEPLOYMENT_ENV',
  'SMARTEXIT_STAGING_SUPABASE_PROJECT_REF',
  'SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_DB_URL',
  'CRON_SECRET',
  'SMARTEXIT_CRON_RECONCILIATION_ENABLED',
  'SMARTEXIT_CRON_TARGET_ENVIRONMENT',
];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

function setStagingEnvironment(vercelEnvironment = 'preview') {
  process.env.VERCEL_ENV = vercelEnvironment;
  process.env.SMARTEXIT_DEPLOYMENT_ENV = 'staging';
  process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF = 'stage-ref';
  process.env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF = 'prod-ref';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stage-ref.supabase.co';
  process.env.SUPABASE_DB_URL = 'postgresql://postgres.stage-ref@pooler.example:6543/postgres';
  process.env.CRON_SECRET = 'x'.repeat(32);
  process.env.SMARTEXIT_CRON_RECONCILIATION_ENABLED = 'true';
  process.env.SMARTEXIT_CRON_TARGET_ENVIRONMENT = 'staging';
}

test.afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
});

test('protection reconciliation rejects Production even with a Staging override', async () => {
  reconciliationCalls = 0;
  setStagingEnvironment('production');
  const response = await route.GET(new Request('https://example.test/api/cron/binance-protection', {
    headers: { authorization: `Bearer ${'x'.repeat(32)}` },
  }));
  assert.equal(response.status, 403);
  assert.equal(reconciliationCalls, 0);
});

test('protection reconciliation invokes only an authorized Staging Preview target', async () => {
  reconciliationCalls = 0;
  setStagingEnvironment();
  const response = await route.GET(new Request('https://example.test/api/cron/binance-protection', {
    headers: { authorization: `Bearer ${'x'.repeat(32)}` },
  }));
  assert.equal(response.status, 200);
  assert.equal(reconciliationCalls, 1);
});

test('protection reconciliation remains disabled without the explicit CRON flag', async () => {
  reconciliationCalls = 0;
  setStagingEnvironment();
  process.env.SMARTEXIT_CRON_RECONCILIATION_ENABLED = 'false';
  const response = await route.GET(new Request('https://example.test/api/cron/binance-protection', {
    headers: { authorization: `Bearer ${'x'.repeat(32)}` },
  }));
  assert.equal(response.status, 403);
  assert.equal(reconciliationCalls, 0);
});
