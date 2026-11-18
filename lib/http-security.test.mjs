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
const { guardedPost, validCsrf } = mod.exports;
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
