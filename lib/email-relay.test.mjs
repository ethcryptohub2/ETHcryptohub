import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

function load(file, stubs) {
  const source = path.resolve(file);
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const delegate = mod.require.bind(mod);
  mod.require = (key) => (key in stubs ? stubs[key] : delegate(key));
  mod._compile(
    ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    source,
  );
  return mod.exports;
}

test('email relay validates secret and rejects unauthorized access', async () => {
  const dispatched = [];
  const route = load('app/api/internal/email-relay/route.ts', {
    '@/lib/auth': { safeEqual: (a, b) => a === b },
    '@/lib/email': {
      sendEmailDirectly: async (...args) => dispatched.push(args),
      EmailDeliveryError: class extends Error {},
    },
    '@/lib/db': { query: async () => ({ rows: [{ allowed: true }] }) },
  });

  process.env.AUTH_SECRET = 'valid-auth-secret-12345678901234567890';
  const req = new NextRequest('http://localhost:3000/api/internal/email-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': 'wrong-secret' },
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Hello',
      text: 'Text',
      html: '<p>Text</p>',
      timestamp: Date.now(),
    }),
  });

  const res = await route.POST(req);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error, 'Unauthorized relay access');
  assert.equal(dispatched.length, 0);
});

test('email relay rejects expired timestamp (replay protection)', async () => {
  const dispatched = [];
  const route = load('app/api/internal/email-relay/route.ts', {
    '@/lib/auth': { safeEqual: (a, b) => a === b },
    '@/lib/email': {
      sendEmailDirectly: async (...args) => dispatched.push(args),
      EmailDeliveryError: class extends Error {},
    },
    '@/lib/db': { query: async () => ({ rows: [{ allowed: true }] }) },
  });

  process.env.AUTH_SECRET = 'valid-auth-secret-12345678901234567890';
  const req = new NextRequest('http://localhost:3000/api/internal/email-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': process.env.AUTH_SECRET },
    body: JSON.stringify({
      to: 'test@example.com',
      subject: 'Hello',
      text: 'Text',
      html: '<p>Text</p>',
      timestamp: Date.now() - 300_000, // 5 min ago
    }),
  });

  const res = await route.POST(req);
  assert.equal(res.status, 422);
  assert.equal(dispatched.length, 0);
});

test('email relay dispatches email when authorized and payload is valid', async () => {
  const dispatched = [];
  const route = load('app/api/internal/email-relay/route.ts', {
    '@/lib/auth': { safeEqual: (a, b) => a === b },
    '@/lib/email': {
      sendEmailDirectly: async (...args) => dispatched.push(args),
      EmailDeliveryError: class extends Error {},
    },
    '@/lib/db': { query: async () => ({ rows: [{ allowed: true }] }) },
  });

  process.env.AUTH_SECRET = 'valid-auth-secret-12345678901234567890';
  const req = new NextRequest('http://localhost:3000/api/internal/email-relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': process.env.AUTH_SECRET },
    body: JSON.stringify({
      to: 'recipient@example.com',
      subject: 'Welcome to SmartExit',
      text: 'Your activation code is 123456',
      html: '<p>Your activation code is 123456</p>',
      timestamp: Date.now(),
    }),
  });

  const res = await route.POST(req);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0][0], 'recipient@example.com');
  assert.equal(dispatched[0][1], 'Welcome to SmartExit');
});
