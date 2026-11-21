import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';

function load(file, stubs) {
  const source = path.resolve(file), mod = new Module(source);
  mod.filename = source; mod.paths = Module._nodeModulePaths(path.dirname(source));
  const delegate = mod.require.bind(mod);
  mod.require = key => key in stubs ? stubs[key] : delegate(key);
  mod._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, source);
  return mod.exports;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const csrf = 'a'.repeat(64);
const request = (body, valid = true) => new NextRequest('https://staging.example/api/settings', {
  method: 'PATCH', body: JSON.stringify(body), headers: { host: 'staging.example', origin: 'https://staging.example',
    ...(valid ? { cookie: `ethcryptohub_csrf=${csrf}`, 'x-csrf-token': csrf } : {}) },
});

function fixture() {
  let token, now = 10_000;
  const users = new Map([1, 2].map(id => [id, { id, email: `user${id}@example.test`, role: id === 1 ? 'admin' : 'user', is_active: 1, is_email_verified: 1, x_handle: `original${id}` }]));
  const sessions = new Map(), writes = [], cookiesSet = [], entitlementChecks = [];
  const notifications = [{ id: 10, userId: 1, read_at: null }, { id: 20, userId: 2, read_at: null }];
  const jar = { get: () => token ? { value: token } : undefined, set: (name, value, options) => { token = value; cookiesSet.push({ name, value, options }); }, delete: () => { token = undefined; } };
  const query = async (sql, values = []) => {
    if (sql.includes('INSERT INTO public.auth_sessions')) { sessions.set(values[1], { userId: values[0], expires: now + values[2] * 1000 }); return { rows: [] }; }
    if (sql.includes('JOIN public.users')) {
      // This populated stand-in enforces the actual SQL boundary, rather than
      // returning an unconditional mock user. No remote database is touched.
      assert.match(sql, /s\.expires_at > NOW\(\)/); assert.match(sql, /u\.is_active = 1 AND u\.is_email_verified = 1/);
      const s = sessions.get(values[0]), u = s && users.get(s.userId);
      return { rows: s && s.expires > now && u?.is_active === 1 && u.is_email_verified === 1 ? [{ ...u }] : [] };
    }
    if (sql.startsWith('DELETE FROM public.auth_sessions')) { sessions.delete(values[0]); return { rows: [] }; }
    if (sql.startsWith('UPDATE public.users SET x_handle')) { writes.push(values); users.get(values[1]).x_handle = values[0]; return { rows: [] }; }
    if (sql.includes('public.user_signal_notifications')) {
      assert.match(sql, /user_id = \$1/);
      const own = notifications.filter(n => n.userId === values[0]);
      if (sql.startsWith('UPDATE')) { for (const n of own) if (values.length === 1 || n.id === values[1]) n.read_at = 'read'; return { rows: [] }; }
      if (sql.includes('COUNT(*)')) return { rows: [{ count: String(own.filter(n => n.read_at === null).length) }] };
      return { rows: own.map(n => ({ ...n })) };
    }
    throw new Error(`Unexpected test query: ${sql}`);
  };
  const auth = load('lib/auth.ts', { 'next/headers': { cookies: async () => jar }, './db': { query } });
  const http = load('lib/http.ts', {});
  const settings = load('app/api/settings/route.ts', { '../../../lib/auth': auth, '../../../lib/db': { query }, '../../../lib/http': http });
  const notices = load('app/api/notifications/route.ts', { '../../../lib/auth': auth, '../../../lib/db': { query }, '../../../lib/http': http,
    '../../../lib/subscriptions': {
      requirePremiumUser: async options => {
        entitlementChecks.push(options);
        return { user: await auth.requireUser() };
      },
      SubscriptionError: class extends Error {},
    } });
  return { auth, settings, notices, users, sessions, writes, cookiesSet, notifications, entitlementChecks, setToken: value => { token = value; }, advance: ms => { now += ms; } };
}

test('session expiry boundary, revocation, inactive and unverified users fail closed with populated identities', async () => {
  const f = fixture(); await f.auth.createSession(1);
  assert.equal((await f.auth.requireAdmin()).id, 1);
  assert.equal(f.cookiesSet[0].options.httpOnly, true); assert.equal(f.cookiesSet[0].options.sameSite, 'strict');
  const token = f.cookiesSet[0].value; assert.equal(f.sessions.has(digest(token)), true); assert.equal(f.sessions.has(token), false);
  f.advance(14 * 86400 * 1000 - 1); assert.equal((await f.auth.currentUser()).id, 1);
  f.advance(1); assert.equal(await f.auth.currentUser(), null);
  await assert.rejects(f.auth.requireAdmin(), e => e.status === 401);
  await f.auth.createSession(2); await assert.rejects(f.auth.requireAdmin(), e => e.status === 403);
  f.users.get(2).is_active = 0; assert.equal(await f.auth.currentUser(), null);
  f.users.get(2).is_active = 1; f.users.get(2).is_email_verified = 0; assert.equal(await f.auth.currentUser(), null);
  f.users.get(2).is_email_verified = 1; await f.auth.destroySession(); assert.equal(await f.auth.currentUser(), null);
});

test('populated account settings cannot change a second customer through a forged body identity', async () => {
  const f = fixture(); await f.auth.createSession(2);
  assert.equal((await f.settings.GET()).headers.get('cache-control'), 'no-store');
  assert.equal((await f.settings.PATCH(request({ xHandle: 'mine', userId: 1, id: 1 }))).status, 200);
  assert.equal(f.users.get(2).x_handle, 'mine'); assert.equal(f.users.get(1).x_handle, 'original1');
  assert.equal((await f.settings.PATCH(request({ xHandle: 'blocked' }, false))).status, 403);
  f.advance(14 * 86400 * 1000);
  assert.equal((await f.settings.PATCH(request({ xHandle: 'expired' }))).status, 401);
  assert.equal(f.writes.length, 1);
});

test('populated notification reads and cross-customer mark-read attacks remain scoped after session changes', async () => {
  const f = fixture(); await f.auth.createSession(2);
  const data = (await (await f.notices.GET()).json()).data;
  assert.deepEqual(data.notifications.map(n => n.id), [20]); assert.equal(data.unreadCount, 1);
  assert.equal((await f.notices.PATCH(request({ action: 'mark_read', id: 10 }))).status, 200);
  assert.equal(f.notifications[0].read_at, null);
  await f.notices.PATCH(request({ action: 'mark_all_read' }));
  assert.equal(f.notifications[1].read_at, 'read'); assert.equal(f.notifications[0].read_at, null);
  await f.auth.createSession(1);
  assert.deepEqual((await (await f.notices.GET()).json()).data.notifications.map(n => n.id), [10]);
  await f.auth.destroySession(); assert.equal((await f.notices.GET()).status, 401);
  assert.deepEqual(f.entitlementChecks, [{ reconcile: false }, undefined, undefined, { reconcile: false }, { reconcile: false }]);
});

test('read-only entitlement reports expiry without writing while the default preserves reconciliation', async () => {
  const sql = [];
  const subscription = load('lib/subscriptions.ts', {
    './db': { query: async statement => {
      sql.push(statement);
      return { rows: statement.startsWith('SELECT') ? [{
        stored_status: 'PREMIUM_ACTIVE',
        premiumStartedAt: '2026-10-01T00:00:00Z',
        premiumExpiresAt: '2026-11-19T00:00:00Z',
        trialExpiresAt: '2026-10-15T00:00:00Z',
        serverNow: '2026-11-20T00:00:00Z',
      }] : [] };
    } },
    './pagination': { TABLE_PAGE_SIZE: 10 },
    './auth': {},
    './subscription-utils': load('lib/subscription-utils.ts', {}),
  });
  const readOnly = await subscription.getSubscriptionEntitlement(42, { reconcile: false });
  assert.equal(readOnly.status, 'PREMIUM_EXPIRED');
  assert.equal(readOnly.hasPremiumAccess, false);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT/);
  await subscription.getSubscriptionEntitlement(42);
  assert.equal(sql.length, 3);
  assert.match(sql[2], /INSERT INTO public\.subscription_audit_log/);
});
