import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntelligenceStatus } from './status.ts';

test('fresh saved snapshots do not imply an approved continuous worker or remote paper execution', () => {
  const status = buildIntelligenceStatus({ id: 3, role: 'user' }, {
    enabledSymbols: 522, snapshotSymbols: 20, latestSnapshotAt: '2026-11-19T00:00:00Z',
  }, Date.parse('2026-11-19T00:00:01Z'));
  assert.equal(status.market.ageSeconds, 1);
  assert.equal(status.market.state, 'WORKER_INACTIVE');
  assert.equal(status.market.continuousFeedVerified, false);
  assert.equal(status.paper.enabled, false);
  assert.equal(status.paper.liveAutopilotEnabled, false);
  assert.equal('operations' in status, false);
});
test('account identity is explicit and administrator operational fields are never returned to a user', () => {
  const a = buildIntelligenceStatus({ id: 2, role: 'admin' }, null);
  const b = buildIntelligenceStatus({ id: 3, role: 'user' }, null);
  assert.equal(a.account.id, 2);
  assert.equal(b.account.id, 3);
  assert.equal(a.operations.globalExecutionLocked, true);
  assert.equal('operations' in b, false);
  assert.throws(() => buildIntelligenceStatus({ id: 0, role: 'admin' }, null));
  assert.throws(() => buildIntelligenceStatus({ id: 3, role: 'owner' }, null));
});
test('unavailable and future dated health remain unavailable rather than inventing data freshness', () => {
  assert.equal(buildIntelligenceStatus({ id: 1, role: 'user' }, null).market.ageSeconds, null);
  const status = buildIntelligenceStatus({ id: 1, role: 'user' }, {
    enabledSymbols: 1, snapshotSymbols: 1, latestSnapshotAt: '2030-01-01T00:00:00Z',
  }, Date.parse('2026-11-19T00:00:00Z'));
  assert.equal(status.market.latestSnapshotAt, null);
});
