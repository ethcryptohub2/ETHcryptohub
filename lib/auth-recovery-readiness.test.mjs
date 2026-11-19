import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPasswordRecoveryReady, PasswordRecoveryUnavailableError } from './auth-recovery-readiness.ts';

test('recovery availability uses schema metadata only and does not look up customer addresses', async () => {
  const calls = [];
  await assert.rejects(assertPasswordRecoveryReady(async (sql) => {
    calls.push(sql); return { rows: [{ ready: false }] };
  }), PasswordRecoveryUnavailableError);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /to_regclass/);
  assert.doesNotMatch(calls[0], /FROM public.users|INSERT|UPDATE|DELETE/);
});
test('recovery requires an explicit readiness result and propagates database failure', async () => {
  await assertPasswordRecoveryReady(async () => ({ rows: [{ ready: true }] }));
  await assert.rejects(assertPasswordRecoveryReady(async () => ({ rows: [] })), PasswordRecoveryUnavailableError);
  await assert.rejects(assertPasswordRecoveryReady(async () => { throw Error('offline'); }), /offline/);
});
