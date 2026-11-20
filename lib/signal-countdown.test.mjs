import assert from 'node:assert/strict';
import test from 'node:test';
import { signalRemainingMs } from './signal-countdown.ts';

test('signal countdown subtracts elapsed time from the server interval and clamps at expiry', () => {
  const serverNow = '2026-11-20T12:00:00.000Z';
  const expiry = '2026-11-20T12:00:03.000Z';
  assert.equal(signalRemainingMs(expiry, serverNow, 0), 3000);
  assert.equal(signalRemainingMs(expiry, serverNow, 1000), 2000);
  assert.equal(signalRemainingMs(expiry, serverNow, 3000), 0);
  assert.equal(signalRemainingMs(expiry, serverNow, 4000), 0);
  assert.equal(signalRemainingMs(expiry, 'invalid', 0), 0);
});
