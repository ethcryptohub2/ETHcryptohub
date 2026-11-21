import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('Alpha approval admits only an explicit Admin POST for the configured Staging token IDs', async t => {
  const filename = path.resolve('app/api/admin/alpha-intelligence/route.ts');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  let admin = false, approved = false, csrf = false;
  const calls = [];
  class AuthError extends Error { status = 403; }
  mod.require = key => ({
    '../../../../lib/auth': { AuthError, requireAdmin: async () => { if (!admin) throw new AuthError(); } },
    '../../../../lib/admin-demo-staging-policy': {
      isPreviewMarketRequestApproved: (_env, host, operation) =>
        approved && host === 'preview.fixture' && operation === 'ALPHA_INTELLIGENCE',
    },
    '../../../../lib/http': { guardedPost: () => csrf ? null : new Response(null, { status: 403 }) },
    '../../../../lib/alpha-intelligence': { acquireAlphaSnapshot: async input => { calls.push(input); return { rows: [] }; } },
    '../../../../lib/alpha-observation-history': {
      alphaHistoryReadEnabled: () => false,
      readAlphaObservationHistory: async () => null,
      storeApprovedAlphaObservations: async () => 'DISABLED',
    },
  })[key];
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  const { GET, POST } = mod.exports;
  const key = 'SMARTEXIT_ALPHA_INTELLIGENCE_TOKEN_IDS';
  const saved = process.env[key];
  t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  process.env[key] = 'ALPHA_1,ALPHA_2';
  const request = { nextUrl: new URL('https://preview.fixture/api/admin/alpha-intelligence'),
    body: null, signal: new AbortController().signal };
  assert.equal((await GET(request)).status, 403);
  admin = true;
  assert.deepEqual(await (await GET(request)).json(), { enabled: false });
  assert.equal((await POST(request)).status, 403);
  csrf = true;
  assert.equal((await POST(request)).status, 503);
  assert.equal((await GET({ ...request, nextUrl: new URL('https://preview.fixture/api/admin/alpha-intelligence?history=1') })).status, 503);
  approved = true;
  assert.deepEqual(await (await GET(request)).json(), { enabled: true });
  assert.equal((await POST({ ...request, body: '{}' })).status, 422);
  assert.equal((await POST({ ...request, nextUrl: new URL('https://other.fixture') })).status, 503);
  assert.deepEqual(calls, []);
  const response = await POST(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).archive, 'DISABLED');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tokenIds, ['ALPHA_1', 'ALPHA_2']);
  assert.equal((await POST(request)).status, 429);
});
