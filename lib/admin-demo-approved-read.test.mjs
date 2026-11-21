import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('an exact Admin Demo read approval cannot admit a provider attempt without a durable claim', async t => {
  const filename = path.resolve('app/api/admin/demo/providers/[provider]/approved-read/route.ts');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const require = mod.require.bind(mod);
  let actor = 7;
  class Rejected extends Error {
    constructor(message, status = 422) { super(message); this.status = status; }
  }
  const wrap = operation => operation({ id: actor }).then(data => Response.json({ data })).catch(error =>
    Response.json({}, { status: error.status }));
  const mocks = {
    '../../_shared': {
      AdminDemoRequestValidationError: Rejected,
      withAdmin: wrap, withMutation: (_request, operation) => wrap(operation),
      resolveProvider: async (_request, provider) => ({ provider, environment: 'DEMO' }),
    },
    '../../../../../../../lib/admin-demo-staging-policy': { isApprovedAdminDemoStagingTarget: () => true },
    '../../../../../../../lib/admin-demo-provider-security': { AdminDemoProviderSecurityError: Rejected },
    '../../../../../../../lib/admin-demo-read-transport': {
      supportsApprovedDemoRead: provider => provider !== 'BITGET',
    },
    '../../../../../../../lib/binance-credentials': { isCredentialEncryptionConfigured: () => true },
    '../../../../../../../lib/db': { query: () => assert.fail('Unexpected database query') },
  };
  mod.require = key => key in mocks ? mocks[key] : require(key);
  mod._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  const { GET, POST } = mod.exports;
  const env = {
    VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'functional-staging', VERCEL_URL: 'staging.example',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'ghecpkpaxbrvehquhzkr',
    SMARTEXIT_ADMIN_DEMO_READ_APPROVED_SHA: 'a'.repeat(40), SMARTEXIT_ADMIN_DEMO_READ_APPROVED_PROVIDER: 'BINANCE',
    SMARTEXIT_ADMIN_DEMO_READ_APPROVED_ADMIN_ID: '7',
    SMARTEXIT_ADMIN_DEMO_READ_APPROVED_UNTIL: new Date(Date.now() + 60_000).toISOString(),
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const context = { params: Promise.resolve({ provider: 'BINANCE' }) };
  const request = { nextUrl: new URL('https://staging.example'), body: null, signal: new AbortController().signal };
  assert.deepEqual((await (await GET(request, context)).json()).data, { state: 'DURABLE_CLAIM_REQUIRED', enabled: false });
  actor = 8;
  assert.equal((await POST(request, context)).status, 503);
  actor = 7;
  assert.equal((await POST({ ...request, body: '{}' }, context)).status, 422);
  assert.equal((await POST(request, { params: Promise.resolve({ provider: 'BITGET' }) })).status, 503);
  assert.equal((await POST(request, context)).status, 503);
  assert.equal((await POST(request, context)).status, 503);
});
