import assert from 'node:assert/strict';
import test from 'node:test';
import { accountHistoricalReplay } from './backtesting-accounting.ts';

const assumptions = { feeBps: 5, slippageBps: 2 };
const trade = { id: 'long', side: 'LONG', entry: 100, exit: 110, quantity: 2, enteredAt: 1000, exitedAt: 3000,
  funding: [{ timestamp: 2000, markPrice: 105, rate: 0.001 }] };

test('charges both fills and applies funding with the direction of the position', () => {
  const short = { ...trade, id: 'short', side: 'SHORT', exitedAt: 4000 };
  const report = accountHistoricalReplay([short, trade], assumptions, 100);
  assert.deepEqual(report.trades.map(row => row.funding), [-0.21, 0.21]);
  assert.ok(Math.abs(report.trades[0].net - 19.496002) < 1e-9);
  assert.ok(Math.abs(report.trades[1].net + 20.084002) < 1e-9);
  assert.ok(Math.abs(report.realized.profitFactor - 19.496002 / 20.084002) < 1e-9);
  assert.ok(Math.abs(report.realized.maxDrawdown - 20.084002 / 119.496002) < 1e-9);
});

test('unknown funding suppresses net metrics and equal exit times do not create phantom drawdown', () => {
  assert.equal(accountHistoricalReplay([{ ...trade, funding: null }], assumptions, 100).realized, null);
  const paired = { ...trade, id: 'short', side: 'SHORT', funding: [] };
  const report = accountHistoricalReplay([{ ...trade, funding: [] }, paired], { feeBps: 0, slippageBps: 0 }, 100);
  assert.equal(report.realized.maxDrawdown, 0);
  assert.throws(() => accountHistoricalReplay([trade, trade], assumptions, 100), /duplicate/);
  assert.throws(() => accountHistoricalReplay([{ ...trade, funding: [{ ...trade.funding[0], timestamp: 3000 }] }], assumptions, 100), /ambiguous/);
});
