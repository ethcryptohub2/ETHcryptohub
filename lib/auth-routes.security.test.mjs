import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

function load(file, stubs) {
  const source = path.resolve(file);
  const mod = new Module(source); mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  const delegate = mod.require.bind(mod);
  mod.require = key => key in stubs ? stubs[key] : delegate(key);
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, source); return mod.exports;
}
const readiness = load('lib/auth-recovery-readiness.ts', {});
const http = load('lib/http.ts', {});
const token = 'a'.repeat(64);
const request = (action, body, csrf = true) => new NextRequest(`https://staging.example/api/auth/${action}`, {
  method: 'POST', body: JSON.stringify(body), headers: { origin: 'https://staging.example', host: 'staging.example',
    'content-type': 'application/json', ...(csrf ? { cookie: `ethcryptohub_csrf=${token}`, 'x-csrf-token': token } : {}) },
});
function fixture({ ready = false, verified = 0, allowed = true, codeRow = null } = {}) {
  const calls = []; const sessions = []; const emails = [];
  const query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('to_regclass')) return { rows: [{ ready }] };
    if (sql.includes('auth_rate_limits')) return { rows: [{ allowed }] };
    if (sql.startsWith('SELECT id, password_hash')) return { rows: [{ id: 3, password_hash: 'mock-hash', is_email_verified: verified, is_active: 1 }] };
    if (sql.startsWith('SELECT id, is_email_verified')) return { rows: [{ id: 3, is_email_verified: verified, is_active: 1 }] };
    if (sql.startsWith('INSERT INTO public.users')) return { rows: [{ id: 3 }] };
    return { rows: [] };
  };
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.includes('SELECT code_hash') && codeRow ? [codeRow] : [], rowCount: 0 };
  }, release() {} };
  const route = load('lib/auth-routes.ts', {
    './auth': { createSession: async id => sessions.push(id), currentUser: async () => null, safeEqual: (a,b) => a === b },
    './db': { query, pool: () => ({ connect: async () => client }) }, './http': http, './auth-recovery-readiness': readiness,
    'bcryptjs': { hash: async () => 'mock-hash', compare: async () => true },
    './email': { EmailDeliveryError: class EmailDeliveryError extends Error {},
      sendVerificationCode: async (...args) => emails.push(args), sendPasswordResetCode: async (...args) => emails.push(args) },
  });
  return { ...route, calls, sessions, emails };
}
test('missing recovery schema produces identical unavailable responses before known/unknown email lookup', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
  const f = fixture(); const responses = [];
  for (const email of ['known@example.test', 'unknown@example.test']) {
    const response = await f.authRoute('password-reset-request', request('password-reset-request', { email }));
    assert.equal(response.status, 503); responses.push(await response.json());
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(responses[0].code, 'PASSWORD_RECOVERY_UNAVAILABLE');
  assert.equal(f.calls.some(x => x.sql.includes('FROM public.users')), false);
  assert.equal(f.emails.length, 0);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
test('missing recovery schema cannot bypass request rate limits', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
    const f = fixture({ allowed: false, ready: false });
    const response = await f.authRoute('password-reset-request', request('password-reset-request', { email: 'test@example.test' }));
    assert.equal(response.status, 429);
    assert.equal(f.calls.some(x => x.sql.includes('to_regclass')), false);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
test('CSRF rejection prevents signup, login and reset from touching storage', async () => {
  const f = fixture();
  for (const action of ['signup', 'login', 'password-reset-request', 'password-reset']) {
    assert.equal((await f.authRoute(action, request(action, {}, false))).status, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.sessions.length, 0);
});
test('signup rejects weak passwords before customer insertion', async () => {
  const f = fixture();
  assert.equal((await f.authRoute('signup', request('signup', { email: 'test@example.test', password: 'short', phoneNumber: '' }))).status, 422);
  assert.equal(f.calls.length, 0);
});
test('signup creates only a verification-required account and sends a mock code, never a session', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
    const f = fixture();
    const response = await f.authRoute('signup', request('signup', { email: 'test@example.test', password: 'test-password-only', phoneNumber: '' }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: { verificationRequired: true } });
    assert.equal(f.emails.length, 1); assert.equal(f.sessions.length, 0);
    assert.equal(f.emails[0][1].length, 6);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
test('unverified identities cannot obtain a login session even with a matching password', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
    const f = fixture(); const response = await f.authRoute('login', request('login', { email: 'test@example.test', password: 'test-only' }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'EMAIL_NOT_VERIFIED');
    assert.equal(f.sessions.length, 0);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
test('rate-limit rejection cannot create a verified login session', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
    const f = fixture({ allowed: false, verified: 1 });
    assert.equal((await f.authRoute('login', request('login', { email: 'test@example.test', password: 'test-only' }))).status, 429);
    assert.equal(f.sessions.length, 0);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
test('expired and locked email verification codes cannot verify an account', async () => {
  const now = Math.floor(Date.now()/1000);
  for (const codeRow of [
    { code_hash: 'test-hash', expires_at: now-1, attempts: 0, locked_until: null },
    { code_hash: 'test-hash', expires_at: now+60, attempts: 5, locked_until: now+900 },
  ]) {
    const f = fixture({ codeRow });
    const response = await f.authRoute('verify', request('verify', { email: 'test@example.test', code: '123456' }));
    assert.equal(response.status, 400);
    assert.equal(f.calls.some(x => x.sql.includes('SET is_email_verified = 1')), false);
    assert.equal(f.calls.some(x => x.sql === 'ROLLBACK'), true);
  }
});
test('expired recovery codes cannot change passwords or revoke existing sessions', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-auth-secret-'.repeat(3);
  try {
    const f = fixture({ ready: true, verified: 1, codeRow: { code_hash: 'test-hash', expires_at: 1, attempts: 0, locked_until: null } });
    const response = await f.authRoute('password-reset', request('password-reset', {
      email: 'test@example.test', code: '123456', password: 'test-password-only', confirmation: 'test-password-only',
    }));
    assert.equal(response.status, 400);
    assert.equal(f.calls.some(x => /UPDATE public.users|DELETE FROM public.auth_sessions/.test(x.sql)), false);
    assert.equal(f.calls.some(x => x.sql === 'ROLLBACK'), true);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
