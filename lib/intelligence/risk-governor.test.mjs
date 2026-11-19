import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPaperRiskPolicy, evaluatePaperRisk } from './risk-governor.ts';

const now = 1_800_000_000_000;
function fixture() {
  return {
    now, policy: defaultPaperRiskPolicy(),
    account: { equity: 10_000, peakEquity: 10_000, dayStartEquity: 10_000, realizedDailyPnl: 0,
      freeMargin: 10_000, exchangeAvailable: true, killSwitch: false, consecutiveLosses: 0, lastLossAt: null, positions: [] },
    intent: { idempotencyKey: 'paper-one', symbol: 'BTCUSDT', side: 'LONG', quantity: 10,
      entryPrice: 100, stopPrice: 95, leverage: 2, estimatedLiquidationPrice: 50, correlationGroup: 'MAJORS' },
    market: { symbol: 'BTCUSDT', source: 'BINANCE_USDM', eventTime: now - 100, receivedAt: now - 50,
      price: 100, bid: 99.9, ask: 100, quoteVolume: 1_000_000, buyQuoteVolume: 600_000,
      sellQuoteVolume: 400_000, bidDepth: 100_000, askDepth: 90_000, fresh: true, sequenceValid: true },
    signal: { id: 'research-one', symbol: 'BTCUSDT', strategy: 'STANDARD', classification: 'READY_FOR_RESEARCH',
      side: 'LONG', score: 1e20, observedAt: now - 100, expiresAt: now + 60_000, reasons: [], evidence: {} },
  };
}
test('paper risk computes deterministic size, exposure and margin without using a score', () => {
  const result = evaluatePaperRisk(fixture());
  assert.equal(result.allowed, true);
  assert.equal(result.riskAmount, 50);
  assert.equal(result.notional, 1000);
  assert.equal(result.marginRequired, 500);
});
for (const [name, change, reason] of [
  ['kill switch', f => { f.account.killSwitch = true; }, 'KILL_SWITCH'],
  ['provider outage', f => { f.account.exchangeAvailable = false; }, 'EXCHANGE_OUTAGE'],
  ['stale data', f => { f.market.eventTime = now - 6000; }, 'STALE_OR_UNVERIFIED_MARKET'],
  ['future timestamps', f => { f.market.receivedAt = now + 1; }, 'STALE_OR_UNVERIFIED_MARKET'],
  ['broken book sequence', f => { f.market.sequenceValid = false; }, 'STALE_OR_UNVERIFIED_MARKET'],
  ['duplicate reservation', f => { f.duplicate = true; }, 'DUPLICATE_INTENT'],
  ['risk budget', f => { f.intent.quantity = 100; }, 'PER_TRADE_RISK'],
  ['daily loss', f => { f.account.realizedDailyPnl = -300; }, 'DAILY_LOSS_LIMIT'],
  ['drawdown', f => { f.account.equity = 9000; }, 'MAXIMUM_DRAWDOWN'],
  ['concurrency', f => { f.account.positions = Array.from({ length: 3 }, () => ({ symbol: 'ETHUSDT', notional: 100, riskAmount: 1, correlationGroup: 'OTHER' })); }, 'MAXIMUM_POSITIONS'],
  ['portfolio exposure', f => { f.policy.maxPortfolioExposurePct = 5; }, 'PORTFOLIO_EXPOSURE'],
  ['correlation labels cannot evade the conservative limit', f => { f.policy.maxCorrelatedExposurePct = 10; f.account.positions = [{ symbol: 'ETHUSDT', notional: 100, riskAmount: 1, correlationGroup: 'UNRELATED' }]; }, 'CORRELATED_EXPOSURE'],
  ['margin', f => { f.account.freeMargin = 100; }, 'INSUFFICIENT_MARGIN'],
  ['leverage', f => { f.intent.leverage = 4; }, 'LEVERAGE_CEILING'],
  ['untrusted liquidation estimate', f => { f.intent.leverage = 20; f.policy.leverageCeiling = 20; f.intent.estimatedLiquidationPrice = 1; }, 'LIQUIDATION_DISTANCE'],
  ['loss cooldown', f => { f.account.consecutiveLosses = 3; f.account.lastLossAt = now - 100; }, 'LOSS_COOLDOWN'],
  ['expired signal', f => { f.signal.expiresAt = now; }, 'SIGNAL_NOT_ELIGIBLE'],
  ['wrong symbol', f => { f.signal.symbol = 'ETHUSDT'; }, 'SYMBOL_OR_SOURCE_MISMATCH'],
  ['strategy permission', f => { f.signal.strategy = 'HIGH_RISK'; }, 'STRATEGY_NOT_PERMITTED'],
  ['symbol exclusion', f => { f.policy.symbolExclusions = ['BTCUSDT']; }, 'SYMBOL_EXCLUDED'],
  ['invalid stop', f => { f.intent.stopPrice = 105; }, 'INVALID_STOP_DIRECTION'],
  ['non-finite data', f => { f.intent.quantity = Infinity; }, 'INVALID_INTENT'],
]) {
  test(`risk rejection overrides any research score: ${name}`, () => {
    const f = fixture(); change(f);
    const result = evaluatePaperRisk(f);
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes(reason), JSON.stringify(result));
  });
}
test('short positions use a correctly sided stop and liquidation distance', () => {
  const f = fixture(); f.intent.side = f.signal.side = 'SHORT';
  f.intent.stopPrice = 105; f.intent.estimatedLiquidationPrice = 150;
  assert.equal(evaluatePaperRisk(f).allowed, true);
});
test('cooldown ends only after its configured interval and independent guards still apply', () => {
  const f = fixture(); f.account.consecutiveLosses = 3; f.account.lastLossAt = now - f.policy.lossCooldownMs;
  assert.equal(evaluatePaperRisk(f).allowed, true);
  f.account.killSwitch = true;
  assert.equal(evaluatePaperRisk(f).allowed, false);
});
test('official Unicode symbol names can be evaluated and explicitly excluded without accepting path characters', () => {
  const f = fixture();
  f.intent.symbol = f.market.symbol = f.signal.symbol = '币安人生USDT';
  assert.equal(evaluatePaperRisk(f).allowed, true);
  f.policy.symbolExclusions = ['币安人生USDT'];
  assert.ok(evaluatePaperRisk(f).reasons.includes('SYMBOL_EXCLUDED'));
  f.intent.symbol = '../BTCUSDT';
  assert.ok(evaluatePaperRisk(f).reasons.includes('INVALID_INTENT'));
});
