import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./admin-demo-audit-notifications.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function('require', 'exports', compiled)(() => ({
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS: { BINANCE: 'DEMO', GATE: 'TESTNET' },
}), exports);

test('projection keeps only evidenced Demo lifecycle outcomes and deduplicates exact audit IDs', () => {
  const base = { provider: 'BINANCE', environment: 'DEMO', createdAt: '2026-11-21T22:00:00.000Z', eventStatus: 'SUCCEEDED' };
  const event = (id, eventType, safeDetails, extra = {}) => ({ ...base, id, eventType, safeDetails, ...extra });
  const protection = event('9007199254740993', 'PROTECTION_VERIFIED', { executionStatus: 'PROTECTED', privateDetail: 'exclude' });
  const notices = exports.projectDemoAuditNotices('BINANCE', [
    event('01', 'ENTRY_SUBMITTED', { executionStatus: 'ENTRY_SUBMITTING' }),
    event('02', 'ENTRY_RECONCILED', { executionStatus: 'ENTRY_UNKNOWN' }),
    event('03', 'PROTECTION_VERIFIED', { milestone: 'TP1' }),
    event('04', 'POSITION_CLOSED', {}),
    event('05', 'PROTECTION_VERIFIED', { executionStatus: 'PROTECTED' }, { provider: 'GATE', environment: 'TESTNET' }),
    protection, protection,
    event('06', 'POSITION_CLOSED', { lifecycleEvent: 'EXECUTION_CLOSED' }),
    event('07', 'RECONCILIATION_REQUIRED', {}, { eventStatus: 'UNCERTAIN' }),
  ]);
  assert.deepEqual(notices.map(({ label }) => label), ['Demo protection verified', 'Demo position closed', 'Demo reconciliation required']);
  assert.equal(notices[0].id, '9007199254740993');
  assert.equal(notices[2].critical, true);
  assert.equal(JSON.stringify(notices).includes('privateDetail'), false);
});

test('Admin Demo JSON preserves the audit timestamp without exposing credential fields', async () => {
  const source = fs.readFileSync(new URL('../app/api/admin/demo/providers/_shared.ts', import.meta.url), 'utf8');
  const shared = {};
  new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(() => ({}), shared);
  const createdAt = new Date('2026-11-21T22:00:00.000Z');
  const response = shared.noStoreJson({ auditEvents: [{ createdAt, apiSecret: 'synthetic' }] });
  assert.deepEqual(await response.json(), { auditEvents: [{ createdAt: '2026-11-21T22:00:00.000Z' }] });
});
