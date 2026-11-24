import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const file = new URL('./http.ts', import.meta.url);
const mod = new Module(file.pathname);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file.pathname);
const { guardedPost, validCsrf, isValidIp, resolveClientIp, isTrustedDeploymentHost, sameOrigin } = mod.exports;
const token = 'a'.repeat(64);
function request(overrides = {}) {
  return new NextRequest('https://preview.example/api/settings', { method: 'POST', headers: {
    host: 'preview.example', origin: 'https://preview.example',
    cookie: `ethcryptohub_csrf=${token}`, 'x-csrf-token': token, ...overrides,
  } });
}
test('same-origin matching CSRF double-submit token passes without performing a mutation', () => {
  assert.equal(validCsrf(request()), true);
  assert.equal(guardedPost(request()), null);
});
test('cross-origin and protocol-spoofed requests cannot use an otherwise valid token', () => {
  for (const origin of ['https://attacker.example', 'http://preview.example', 'https://preview.example/path']) {
    assert.equal(guardedPost(request({ origin })).status, 403);
  }
});
test('missing or mismatched CSRF cookie/header fails closed', () => {
  for (const headers of [{ cookie: '' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'b'.repeat(64) }, { 'x-csrf-token': 'a' }]) {
    assert.equal(guardedPost(request(headers)).status, 403);
  }
});

test('isValidIp validates standard IPv4 and IPv6 while rejecting invalid strings', () => {
  assert.equal(isValidIp('192.168.1.1'), true);
  assert.equal(isValidIp('203.0.113.195'), true);
  assert.equal(isValidIp('2001:db8::1'), true);
  assert.equal(isValidIp('::1'), true);
  assert.equal(isValidIp(''), false);
  assert.equal(isValidIp('unknown'), false);
  assert.equal(isValidIp('192.168.1.300'), false);
  assert.equal(isValidIp('192.168.1.1:8080'), false);
  assert.equal(isValidIp('attacker.com'), false);
});

test('resolveClientIp extracts valid IP and prioritizes proxy headers safely', () => {
  const req1 = new NextRequest('https://preview.example', { headers: { 'x-vercel-forwarded-for': '198.51.100.1, 10.0.0.1' } });
  assert.equal(resolveClientIp(req1), '198.51.100.1');

  const req2 = new NextRequest('https://preview.example', { headers: { 'cf-connecting-ip': '198.51.100.2' } });
  assert.equal(resolveClientIp(req2), '198.51.100.2');

  const req3 = new NextRequest('https://preview.example', { headers: { 'x-forwarded-for': '198.51.100.3, 10.0.0.2' } });
  assert.equal(resolveClientIp(req3), '198.51.100.3');

  const req4 = new NextRequest('https://preview.example', { headers: { 'x-forwarded-for': 'invalid-ip' } });
  assert.equal(resolveClientIp(req4), null);
});

test('trusted proxy x-forwarded-host passes CSRF only within allowed deployment boundary', () => {
  assert.equal(isTrustedDeploymentHost('app.smartexit.com', { APP_URL: 'https://app.smartexit.com' }), true);
  assert.equal(isTrustedDeploymentHost('evil.com', { APP_URL: 'https://app.smartexit.com' }), false);
  process.env.APP_URL = 'https://app.smartexit.com';
  try {
    const trustedReq = new NextRequest('https://internal-lb/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'internal-lb',
        'x-forwarded-host': 'app.smartexit.com',
        'x-forwarded-proto': 'https',
        origin: 'https://app.smartexit.com',
        cookie: `ethcryptohub_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    assert.equal(sameOrigin(trustedReq), true);
    assert.equal(guardedPost(trustedReq), null);

    const spoofedReq = new NextRequest('https://internal-lb/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'internal-lb',
        'x-forwarded-host': 'malicious-phishing.com',
        'x-forwarded-proto': 'https',
        origin: 'https://malicious-phishing.com',
        cookie: `ethcryptohub_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    assert.equal(sameOrigin(spoofedReq), false);
    assert.equal(guardedPost(spoofedReq).status, 403);
  } finally {
    delete process.env.APP_URL;
  }
});
