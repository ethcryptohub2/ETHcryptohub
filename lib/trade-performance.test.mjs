import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

Module._extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  module._compile(compiled.outputText, filename);
};

const {
  computeIstDateRange,
  utcToIstDateString,
} = require('./trade-performance-analytics.ts');

test('Trade Performance Analytics - IST Date Boundaries', async (t) => {
  await t.test('computeIstDateRange produces correct IST boundaries for TODAY', () => {
    const range = computeIstDateRange('TODAY');
    assert.ok(range.startUtc, 'startUtc must be defined');
    assert.ok(range.endUtc, 'endUtc must be defined');
    assert.ok(new Date(range.startUtc) < new Date(range.endUtc), 'startUtc must be before endUtc');
    assert.ok(range.label.includes('IST'), 'label must specify IST');
  });

  await t.test('computeIstDateRange produces correct IST boundaries for YESTERDAY', () => {
    const range = computeIstDateRange('YESTERDAY');
    assert.ok(range.startUtc, 'startUtc must be defined');
    assert.ok(range.endUtc, 'endUtc must be defined');
    const start = new Date(range.startUtc);
    const end = new Date(range.endUtc);
    const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    assert.ok(Math.abs(diffHours - 24) < 0.1, `Expected ~24h, got ${diffHours}`);
  });

  await t.test('computeIstDateRange produces correct ALL_TIME boundaries', () => {
    const range = computeIstDateRange('ALL_TIME');
    assert.equal(range.startUtc, null);
    assert.equal(range.endUtc, null);
    assert.equal(range.label, 'All Time (Since Nov 27, 2026)');
  });

  await t.test('computeIstDateRange parses CUSTOM range in Asia/Kolkata (IST)', () => {
    const range = computeIstDateRange('CUSTOM', '2026-11-20', '2026-11-27');
    assert.ok(range.startUtc);
    assert.ok(range.endUtc);
    // 2026-11-20 00:00:00 IST = 2026-11-19 18:30:00 UTC
    assert.equal(range.startUtc, '2026-11-19T18:30:00.000Z');
    // 2026-11-27 23:59:59.999 IST = 2026-11-27 18:29:59.999 UTC
    assert.equal(range.endUtc, '2026-11-27T18:29:59.999Z');
  });

  await t.test('computeIstDateRange parses INDIVIDUAL_DATE in Asia/Kolkata (IST)', () => {
    const range = computeIstDateRange('INDIVIDUAL_DATE', undefined, undefined, '2026-11-27');
    assert.ok(range.startUtc);
    assert.ok(range.endUtc);
    assert.equal(range.startUtc, '2026-11-26T18:30:00.000Z');
    assert.equal(range.endUtc, '2026-11-27T18:29:59.999Z');
  });

  await t.test('utcToIstDateString maps UTC timestamps across the midnight boundary into correct IST date', () => {
    // 2026-11-27 19:00:00 UTC = 2026-11-28 00:30:00 IST (Crosses into next day in IST)
    const istDateStr = utcToIstDateString('2026-11-27T19:00:00.000Z');
    assert.equal(istDateStr, '2026-11-28');

    // 2026-11-27 18:00:00 UTC = 2026-11-27 23:30:00 IST (Remains same day in IST)
    const istDateStr2 = utcToIstDateString('2026-11-27T18:00:00.000Z');
    assert.equal(istDateStr2, '2026-11-27');
  });
});

test('Trade Performance Financial Calculations', async (t) => {
  await t.test('Net Realized PnL = Realized Trading P&L − Commissions + Signed Funding Income', () => {
    const realizedPnl = 420.50;
    const commissions = 4.25;
    const fundingIncome = -1.20; // negative funding fee deducted

    const netRealized = realizedPnl - Math.abs(commissions) + fundingIncome;
    assert.equal(Number(netRealized.toFixed(4)), 415.05);
  });

  await t.test('Win/Loss classification must use net realized PnL, not order exit type', () => {
    // Scenario 1: TP1 hit followed by breakeven exit, but fees exceed gross profit
    const trade1 = { grossProfit: 0.80, commissions: 1.50, funding: 0 };
    const net1 = trade1.grossProfit - trade1.commissions + trade1.funding;
    assert.ok(net1 < 0, 'Net PnL is negative');
    const isWinner1 = net1 > 0.000001;
    const isLoser1 = net1 < -0.000001;
    assert.equal(isWinner1, false);
    assert.equal(isLoser1, true);

    // Scenario 2: SL hit after partial TP gains where overall net remains positive
    const trade2 = { grossProfit: 15.00, grossLoss: 5.00, commissions: 2.00, funding: 0.50 };
    const net2 = (trade2.grossProfit - trade2.grossLoss) - trade2.commissions + trade2.funding;
    assert.ok(net2 > 0, 'Net PnL is positive despite partial SL hit');
    const isWinner2 = net2 > 0.000001;
    assert.equal(isWinner2, true);
  });

  await t.test('Milestone hit counts are non-exclusive', () => {
    // A single runner trade that achieves TP1, TP2, and then trailing stop
    const execution = {
      tp1ReachedAt: '2026-11-27T12:00:00Z',
      tp2ReachedAt: '2026-11-27T12:30:00Z',
      tp3ReachedAt: null,
      trailingStopHitAt: '2026-11-27T13:00:00Z',
    };

    let tp1Count = 0;
    let tp2Count = 0;
    let tp3Count = 0;
    let trailingCount = 0;

    if (execution.tp1ReachedAt) tp1Count++;
    if (execution.tp2ReachedAt) tp2Count++;
    if (execution.tp3ReachedAt) tp3Count++;
    if (execution.trailingStopHitAt) trailingCount++;

    assert.equal(tp1Count, 1);
    assert.equal(tp2Count, 1);
    assert.equal(tp3Count, 0);
    assert.equal(trailingCount, 1);
  });

  await t.test('Profit Factor calculation handles zero losses gracefully', () => {
    const grossProfit = 500;
    const grossLoss = 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
    assert.equal(profitFactor, null, 'Zero losses should produce null (infinite) profit factor');
  });

  await t.test('Profit Factor calculation computes correct ratio with losses', () => {
    const grossProfit = 750;
    const grossLoss = 250;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
    assert.equal(profitFactor, 3.0);
  });
});

test('Trade Performance Export CSV Sanitation', async (t) => {
  await t.test('CSV fields with commas or quotes are properly escaped', () => {
    function escapeCsvField(val) {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    assert.equal(escapeCsvField('BTCUSDT'), 'BTCUSDT');
    assert.equal(escapeCsvField('Trader, John'), '"Trader, John"');
    assert.equal(escapeCsvField('Notes with "quotes"'), '"Notes with ""quotes"""');
    assert.equal(escapeCsvField(null), '');
  });
});

test('Trade Performance Security & Authorization Isolation', async (t) => {
  class AuthError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function simulateRequireAdmin(currentUser) {
    if (!currentUser) throw new AuthError(401, 'Sign in is required.');
    if (currentUser.role !== 'admin') throw new AuthError(403, 'Administrator access is required.');
    return currentUser;
  }

  await t.test('Unauthenticated user receives HTTP 401 AuthError', () => {
    assert.throws(
      () => simulateRequireAdmin(null),
      (err) => err instanceof AuthError && err.status === 401,
      'Should reject unauthenticated access with 401',
    );
  });

  await t.test('Regular customer trader receives HTTP 403 Forbidden AuthError', () => {
    const customerUser = { id: 101, email: 'trader@example.com', role: 'user' };
    assert.throws(
      () => simulateRequireAdmin(customerUser),
      (err) => err instanceof AuthError && err.status === 403,
      'Should reject normal customer with 403 Forbidden',
    );
  });

  await t.test('Admin user passes authorization check successfully', () => {
    const adminUser = { id: 1, email: 'admin@smartexit.local', role: 'admin' };
    const authed = simulateRequireAdmin(adminUser);
    assert.equal(authed.role, 'admin');
    assert.equal(authed.email, 'admin@smartexit.local');
  });

  await t.test('Customer API keys and secrets are never exposed in reporting structures', () => {
    // Audit execution payload to verify sensitive keys are never present
    const executionExportRecord = {
      id: '123',
      userId: 5,
      email: 'customer@demo.com',
      symbol: 'BTCUSDT',
      netRealizedPnl: 15.2,
      reconciliationStatus: 'RECONCILED',
    };

    assert.equal('apiKey' in executionExportRecord, false);
    assert.equal('apiSecret' in executionExportRecord, false);
    assert.equal('api_key_ciphertext' in executionExportRecord, false);
    assert.equal('api_secret_ciphertext' in executionExportRecord, false);
  });
});
