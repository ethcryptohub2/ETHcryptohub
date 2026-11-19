import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

function load(file, stubs) {
  const source = path.resolve(file); const mod = new Module(source);
  mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  const delegate = mod.require.bind(mod);
  mod.require = key => key in stubs ? stubs[key] : delegate(key);
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, source);
  return mod.exports;
}
class AuthError extends Error { constructor(status, message) { super(message); this.status = status; } }
const http = load('lib/http.ts', {});
function fixture(signedIn = true) {
  const calls = [];
  const route = load('app/api/intelligence/route.ts', {
    '../../../lib/auth': { AuthError, requireUser: async () => {
      if (!signedIn) throw new AuthError(401, 'Sign in is required.'); return { id: 3, role: 'user' };
    } },
    '../../../lib/http': http,
    '../../../lib/intelligence/server-status': { readIntelligenceStatus: async actor => { calls.push(actor); return { account: { id: actor.id }, paper: { enabled: false } }; } },
  });
  return { ...route, calls };
}
test('intelligence status rejects guests before reading any shared status', async () => {
  const f = fixture(false); assert.equal((await f.GET(new NextRequest('https://staging.example/api/intelligence'))).status, 401);
  assert.equal(f.calls.length, 0);
});
test('tenant overrides are rejected rather than used as account selectors', async () => {
  const f = fixture(); assert.equal((await f.GET(new NextRequest('https://staging.example/api/intelligence?tenantId=2'))).status, 422);
  assert.equal(f.calls.length, 0);
});
test('read status uses only the authenticated actor and is not cacheable', async () => {
  const f = fixture(); const response = await f.GET(new NextRequest('https://staging.example/api/intelligence'));
  assert.equal((await response.json()).data.account.id, 3); assert.equal(f.calls[0].id, 3);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('remote paper mutations require CSRF but remain disabled even with valid confirmation and arbitrary flags', async () => {
  const f = fixture();
  assert.equal((await f.POST(new NextRequest('https://staging.example/api/intelligence', { method: 'POST' }))).status, 403);
  const token = 'a'.repeat(64);
  const response = await f.POST(new NextRequest('https://staging.example/api/intelligence', { method: 'POST',
    body: JSON.stringify({ mode: 'LIVE_AUTOPILOT', enabled: true, tenantId: 2, confirmation: true }),
    headers: { host: 'staging.example', origin: 'https://staging.example', cookie: `ethcryptohub_csrf=${token}`, 'x-csrf-token': token },
  }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PAPER_FOUNDATION_INACTIVE');
  assert.equal(f.calls.length, 0);
});
