import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('Demo credential storage scopes readiness and mutations independently of execution', async t => {
  const filename = path.resolve('app/api/admin/demo/providers/[provider]/credential-storage/route.ts');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const require = mod.require.bind(mod);
  let installed = false;
  let encryption = true;
  let actor = true;
  let csrf = true;
  const writes = [];
  class Validation extends Error {}
  const wrap = operation => !actor ? Promise.resolve(Response.json({}, { status: 403 })) :
    operation({ id: 7 }).then(data => Response.json({ data })).catch(error =>
      Response.json({}, { status: error instanceof Validation ? 422 : 503 }));
  const mocks = {
    '../../_shared': {
      AdminDemoRequestValidationError: Validation,
      withAdmin: wrap, withMutation: (_request, operation) => csrf ? wrap(operation) : Promise.resolve(Response.json({}, { status: 403 })),
      resolveProvider: async (_request, provider, environment) => {
        const expected = provider === 'GATE' ? 'TESTNET' : 'DEMO';
        if (environment !== undefined && environment !== expected) throw new Validation();
        return { provider, environment: expected };
      },
    },
    '../../../../../../../lib/admin-demo-staging-policy': { isApprovedAdminDemoStagingTarget: () => true },
    '../../../../../../../lib/admin-demo-provider-repository': {
      createAdminDemoProviderRepository: () => ({
        getCredentialStatus: async () => ({ configured: true, updatedAt: null, apiKey: 'must never return' }),
        saveCredential: async (id, provider, input) => {
          writes.push([id, provider, Boolean(input.passphrase)]);
          return { configured: true, updatedAt: null, apiKey: 'must never return' };
        },
        revokeCredential: async (id, provider, options) => { writes.push([id, provider, options]); return true; },
      }),
    },
    '../../../../../../../lib/binance-credentials': { isCredentialEncryptionConfigured: () => encryption },
    '../../../../../../../lib/db': { query: async sql => ({ rows: sql.includes('relrowsecurity') ? [{ installed }] : [{ ready: true }] }) },
  };
  mod.require = key => key in mocks ? mocks[key] : require(key);
  mod._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  const { GET, POST, DELETE } = mod.exports;
  const env = {
    VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'functional-staging', VERCEL_URL: 'staging.example',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'ghecpkpaxbrvehquhzkr',
    SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_SHA: 'a'.repeat(40),
    SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_PROVIDER: 'BITGET',
    SMARTEXIT_ADMIN_DEMO_CREDENTIALS_APPROVED_UNTIL: new Date(Date.now() + 60_000).toISOString(),
    SMARTEXIT_ADMIN_DEMO_CREDENTIALS_DELETE_APPROVED: 'false',
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const context = { params: Promise.resolve({ provider: 'BITGET' }) };
  const request = { nextUrl: new URL('https://staging.example'), body: null };
  const payload = { apiKey: 'synthetic-fixture', apiSecret: 'synthetic-fixture', environment: 'DEMO', ownerConfirmed: true };
  const send = extra => POST({ ...request, json: async () => ({ ...payload, ...extra }) }, context);
  assert.equal((await (await GET(request, context)).json()).data.state, 'SCHEMA_REQUIRED');
  installed = true;
  encryption = false;
  assert.equal((await (await GET(request, context)).json()).data.state, 'ENCRYPTION_REQUIRED');
  encryption = true;
  assert.deepEqual((await (await GET(request, context)).json()).data, { state: 'READY', enabled: true, removalEnabled: false, configured: true, updatedAt: null });
  assert.equal((await send()).status, 422);
  assert.equal((await send({ passphrase: 'fixture', environment: 'TESTNET' })).status, 422);
  actor = false;
  assert.equal((await send({ passphrase: 'fixture' })).status, 403);
  actor = true;
  csrf = false;
  assert.equal((await send({ passphrase: 'fixture' })).status, 403);
  csrf = true;
  assert.deepEqual(writes, []);
  assert.deepEqual((await (await send({ passphrase: 'fixture' })).json()).data, { configured: true, updatedAt: null });
  assert.equal((await DELETE(request, context)).status, 503);
  process.env.SMARTEXIT_ADMIN_DEMO_CREDENTIALS_DELETE_APPROVED = 'true';
  assert.deepEqual((await (await DELETE(request, context)).json()).data, { revoked: true });
  assert.deepEqual(writes, [[7, 'BITGET', true], [7, 'BITGET', { erase: true }]]);
  process.env.VERCEL_ENV = 'production';
  assert.equal((await send({ passphrase: 'fixture' })).status, 503);
  assert.equal(writes.length, 2);
});
