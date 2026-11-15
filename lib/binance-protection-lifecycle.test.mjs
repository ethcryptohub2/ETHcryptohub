import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'binance-protection-lifecycle.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './binance-algo-orders' && parent?.filename === sourcePath) {
    const dependencyPath = path.join(directory, 'binance-algo-orders.ts');
    const dependency = new Module(dependencyPath);
    dependency.filename = dependencyPath;
    dependency.paths = Module._nodeModulePaths(directory);
    const dependencySource = fs.readFileSync(dependencyPath, 'utf8');
    const dependencyCompiled = ts.transpileModule(dependencySource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    dependency._compile(dependencyCompiled.outputText, dependencyPath);
    return dependency.exports;
  }
  return originalLoad.call(this, request, parent, isMain);
};
sourceModule._compile(compiled.outputText, sourcePath);
Module._load = originalLoad;
const {
  BinanceProtectionError,
  assertEmergencyStopInactive,
  assertTrailingActivationDirection,
  buildTrailingStopOrderParameters,
  cancelProtectionAfterFlat,
  closePositionAndVerify,
  getTrailingActivationPrice,
  hasReachedTarget,
  verifyTrailingStopOrder,
} = sourceModule.exports;

function fakeExchange(overrides = {}) {
  let amount = '0';
  let orders = [];
  const calls = { close: [], cancel: [] };
  return {
    calls,
    setAmount(value) { amount = value; },
    setOrders(value) { orders = value; },
    async getPosition(symbol) {
      if (overrides.getPosition) return overrides.getPosition(symbol, amount);
      return { symbol, amount };
    },
    async closePosition(input) {
      calls.close.push(input);
      if (overrides.closePosition) return overrides.closePosition(input, (value) => { amount = value; });
      amount = '0';
      return { status: 'FILLED' };
    },
    async getCloseOrder(symbol, clientOrderId) {
      if (overrides.getCloseOrder) return overrides.getCloseOrder(symbol, clientOrderId);
      return { status: 'FILLED' };
    },
    async getOpenProtectionOrders(symbol) {
      if (overrides.getOpenProtectionOrders) return overrides.getOpenProtectionOrders(symbol, orders);
      return orders;
    },
    async cancelProtectionOrder(symbol, order) {
      calls.cancel.push(order);
      if (overrides.cancelProtectionOrder) return overrides.cancelProtectionOrder(symbol, order);
      orders = orders.filter((candidate) => candidate.id !== order.id);
    },
  };
}

test('LONG TP1 activation rounds up to the next Binance tick, never arming early', () => {
  assert.equal(getTrailingActivationPrice('LONG', '100.1239', '0.01'), '100.13');
  assert.equal(hasReachedTarget('LONG', '100.13', '100.13'), true);
});

test('SHORT TP1 activation rounds down to the next Binance tick, never arming early', () => {
  assert.equal(getTrailingActivationPrice('SHORT', '100.1231', '0.01'), '100.12');
  assert.equal(hasReachedTarget('SHORT', '100.12', '100.12'), true);
});

test('trailing activation must be above the mark for LONG closes and below it for SHORT closes', () => {
  assert.doesNotThrow(() => assertTrailingActivationDirection('LONG', '101', '100'));
  assert.doesNotThrow(() => assertTrailingActivationDirection('SHORT', '99', '100'));
  assert.throws(() => assertTrailingActivationDirection('LONG', '100', '100'), /closing direction/);
  assert.throws(() => assertTrailingActivationDirection('SHORT', '101', '100'), /closing direction/);
});

test('LONG trailing order arms at TP1 and trails the full position at exactly 1%', () => {
  assert.deepEqual(buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.125',
    tp1: '100.1239', tickSize: '0.01', clientAlgoId: 'trail-long',
  }), {
    algoType: 'CONDITIONAL', symbol: 'BTCUSDT', side: 'SELL',
    type: 'TRAILING_STOP_MARKET', activatePrice: '100.13',
    callbackRate: '1', quantity: '0.125', reduceOnly: 'true',
    workingType: 'MARK_PRICE', positionSide: 'BOTH', clientAlgoId: 'trail-long',
  });
});

test('SHORT trailing order arms at TP1 and trails the full position at exactly 1%', () => {
  assert.deepEqual(buildTrailingStopOrderParameters({
    symbol: 'ETHUSDT', positionSide: 'SHORT', quantity: '2.5',
    tp1: '100.1231', tickSize: '0.01', clientAlgoId: 'trail-short',
  }), {
    algoType: 'CONDITIONAL', symbol: 'ETHUSDT', side: 'BUY',
    type: 'TRAILING_STOP_MARKET', activatePrice: '100.12',
    callbackRate: '1', quantity: '2.5', reduceOnly: 'true',
    workingType: 'MARK_PRICE', positionSide: 'BOTH', clientAlgoId: 'trail-short',
  });
});

test('exchange response must confirm the complete active trailing order', () => {
  const expected = buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.125',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'trail-verified',
  });
  assert.equal(verifyTrailingStopOrder({
    algoId: 123,
    clientAlgoId: expected.clientAlgoId,
    algoStatus: 'NEW',
    algoType: 'CONDITIONAL',
    symbol: expected.symbol,
    side: expected.side,
    positionSide: 'BOTH',
    orderType: expected.type,
    activatePrice: expected.activatePrice,
    callbackRate: expected.callbackRate,
    quantity: expected.quantity,
    reduceOnly: true,
    workingType: expected.workingType,
  }, expected), '123');
});

test('rejected or incomplete trailing protection is never reported as active', () => {
  const expected = buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.125',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'trail-rejected',
  });
  assert.equal(verifyTrailingStopOrder({
    algoId: 123, clientAlgoId: expected.clientAlgoId, algoStatus: 'REJECTED',
    algoType: 'CONDITIONAL', symbol: expected.symbol, side: expected.side,
    positionSide: 'BOTH', orderType: expected.type, activatePrice: expected.activatePrice,
    callbackRate: expected.callbackRate, quantity: expected.quantity,
    reduceOnly: true, workingType: expected.workingType,
  }, expected), null);
  assert.equal(verifyTrailingStopOrder({ algoId: 123 }, expected), null);
});

test('a trailing response with a wrong quantity fails protection verification', () => {
  const expected = buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.125',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'trail-size',
  });
  assert.equal(verifyTrailingStopOrder({
    algoId: 123, clientAlgoId: expected.clientAlgoId, algoStatus: 'NEW',
    algoType: 'CONDITIONAL', symbol: expected.symbol, side: expected.side,
    positionSide: 'BOTH', orderType: expected.type, activatePrice: expected.activatePrice,
    callbackRate: expected.callbackRate, quantity: '0.124',
    reduceOnly: true, workingType: expected.workingType,
  }, expected), null);
});

test('LONG TP1 and TP2 preserve the full quantity in one trailing order without an exit order', () => {
  const atTp1 = buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.5',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'long-tp1',
  });
  const atTp2 = buildTrailingStopOrderParameters({
    symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '0.5',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'long-tp2',
  });
  assert.equal(hasReachedTarget('LONG', '105', '105'), true);
  assert.equal(atTp1.type, 'TRAILING_STOP_MARKET');
  assert.equal(atTp2.type, 'TRAILING_STOP_MARKET');
  assert.equal(atTp2.quantity, '0.5');
  assert.equal('closePosition' in atTp2, false);
});

test('SHORT TP1 and TP2 preserve the full quantity in one trailing order without an exit order', () => {
  const atTp1 = buildTrailingStopOrderParameters({
    symbol: 'ETHUSDT', positionSide: 'SHORT', quantity: '2',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'short-tp1',
  });
  const atTp2 = buildTrailingStopOrderParameters({
    symbol: 'ETHUSDT', positionSide: 'SHORT', quantity: '2',
    tp1: '100', tickSize: '0.1', clientAlgoId: 'short-tp2',
  });
  assert.equal(hasReachedTarget('SHORT', '95', '95'), true);
  assert.equal(atTp1.type, 'TRAILING_STOP_MARKET');
  assert.equal(atTp2.type, 'TRAILING_STOP_MARKET');
  assert.equal(atTp2.quantity, '2');
  assert.equal('closePosition' in atTp2, false);
});

test('TP3 threshold is directionally recognized for LONG and SHORT', () => {
  assert.equal(hasReachedTarget('LONG', '110', '110'), true);
  assert.equal(hasReachedTarget('SHORT', '90', '90'), true);
  assert.equal(hasReachedTarget('LONG', '109.99', '110'), false);
  assert.equal(hasReachedTarget('SHORT', '90.01', '90'), false);
});

test('reduce-only closure uses the complete LONG position quantity', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('2.500');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'close-long',
  });
  assert.equal(result.closed, true);
  assert.deepEqual(exchange.calls.close[0], {
    symbol: 'BTCUSDT', side: 'SELL', quantity: '2.500',
    reduceOnly: true, clientOrderId: 'close-long',
  });
});

test('reduce-only closure uses the complete SHORT position quantity', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('-0.025');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'ETHUSDT', positionSide: 'SHORT', clientOrderId: 'close-short',
  });
  assert.equal(result.closed, true);
  assert.equal(exchange.calls.close[0].side, 'BUY');
  assert.equal(exchange.calls.close[0].quantity, '0.025');
});

test('a partial close is not reported as closed', async () => {
  const exchange = fakeExchange({
    closePosition: async () => ({ status: 'PARTIALLY_FILLED' }),
  });
  exchange.setAmount('1');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'partial',
  });
  assert.equal(result.closed, false);
  assert.equal(result.remainingQuantity, '1');
});

test('network timeout reconciles by the same client order id without resubmitting', async () => {
  const exchange = fakeExchange({
    closePosition: async (_input, setAmount) => {
      setAmount('0');
      throw new Error('timeout');
    },
  });
  exchange.setAmount('1');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'timeout-close',
  });
  assert.equal(result.closed, true);
  assert.equal(exchange.calls.close.length, 1);
});

test('unknown timeout leaves the actual residual quantity visible and does not retry', async () => {
  const exchange = fakeExchange({
    closePosition: async () => { throw new Error('timeout'); },
    getCloseOrder: async () => { throw new Error('order lookup unavailable'); },
  });
  exchange.setAmount('0.4');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'unknown-close',
  });
  assert.equal(result.closed, false);
  assert.equal(result.remainingQuantity, '0.4');
  assert.equal(exchange.calls.close.length, 1);
});

test('rejected protective recovery close is not reported as flat', async () => {
  const exchange = fakeExchange({
    closePosition: async () => { throw new Error('rejected'); },
    getCloseOrder: async () => ({ status: 'REJECTED' }),
  });
  exchange.setAmount('0.3');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'rejected-close',
  });
  assert.equal(result.closed, false);
});

test('a conflicting exchange position is never closed', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('-1');
  await assert.rejects(
    closePositionAndVerify(exchange, {
      symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'wrong-way',
    }),
    BinanceProtectionError,
  );
  assert.equal(exchange.calls.close.length, 0);
});

test('repeated recovery after confirmed closure does not submit a duplicate', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('0');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG', clientOrderId: 'already-flat',
  });
  assert.equal(result.closed, true);
  assert.equal(exchange.calls.close.length, 0);
});

test('restart recovery reconciles an existing close order instead of duplicating it', async () => {
  const exchange = fakeExchange({
    getCloseOrder: async () => ({ status: 'FILLED' }),
  });
  exchange.setAmount('0.2');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG',
    clientOrderId: 'restart-close', reconcileExistingOrder: true,
  });
  assert.equal(result.closed, false);
  assert.equal(result.remainingQuantity, '0.2');
  assert.match(result.reason, /no duplicate was submitted/);
  assert.equal(exchange.calls.close.length, 0);
});

test('restart recovery retries only when Binance explicitly reports the client order is absent', async () => {
  const exchange = fakeExchange({
    getCloseOrder: async () => { throw Object.assign(new Error('Order does not exist'), { exchangeCode: -2013 }); },
  });
  exchange.setAmount('0.2');
  const result = await closePositionAndVerify(exchange, {
    symbol: 'BTCUSDT', positionSide: 'LONG',
    clientOrderId: 'restart-absent', reconcileExistingOrder: true,
  });
  assert.equal(result.closed, true);
  assert.equal(exchange.calls.close.length, 1);
});

test('tick precision is preserved for very small activation prices', () => {
  assert.equal(getTrailingActivationPrice('LONG', '0.00012349', '0.00000010'), '0.0001235');
  assert.equal(getTrailingActivationPrice('SHORT', '0.00012341', '0.00000010'), '0.0001234');
});

test('protective orders are not cancelled while any position quantity remains', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('0.01');
  exchange.setOrders([{ id: 'sl-1', clientId: 'stop-1' }]);
  await assert.rejects(
    cancelProtectionAfterFlat(exchange, 'BTCUSDT', ['sl-1']),
    /retained because Binance has not confirmed a flat position/,
  );
  assert.equal(exchange.calls.cancel.length, 0);
});

test('obsolete protective orders are cancelled only after flat state and absence are verified', async () => {
  const exchange = fakeExchange();
  exchange.setAmount('0');
  exchange.setOrders([
    { id: 'sl-1', clientId: 'stop-1' },
    { id: 'unrelated', clientId: 'other' },
  ]);
  await cancelProtectionAfterFlat(exchange, 'BTCUSDT', ['sl-1', 'stop-1']);
  assert.equal(exchange.calls.cancel.length, 1);
  assert.deepEqual(exchange.calls.cancel[0], { id: 'sl-1', clientId: 'stop-1' });
});

test('failed cancellation is surfaced rather than treated as success', async () => {
  const exchange = fakeExchange({
    cancelProtectionOrder: async () => {},
    getOpenProtectionOrders: async (_symbol, orders) => orders,
  });
  exchange.setAmount('0');
  exchange.setOrders([{ id: 'sl-1', clientId: 'stop-1' }]);
  await assert.rejects(
    cancelProtectionAfterFlat(exchange, 'BTCUSDT', ['sl-1']),
    /still reports an obsolete protective order/,
  );
});

test('emergency stop blocks new entries for the selected environment', () => {
  assert.doesNotThrow(() => assertEmergencyStopInactive(false, 'DEMO'));
  assert.throws(() => assertEmergencyStopInactive(true, 'DEMO'), /DEMO emergency stop is active/);
  assert.throws(() => assertEmergencyStopInactive(true, 'LIVE'), /LIVE emergency stop is active/);
});
