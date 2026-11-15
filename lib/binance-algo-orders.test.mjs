import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'binance-algo-orders.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const {
  BinanceAlgoOrderError,
  buildCloseAllAlgoOrderParameters,
  cancelBinanceAlgoOrder,
  findUniqueOpenBinanceAlgoOrder,
  listOpenBinanceAlgoOrders,
  queryBinanceAlgoOrder,
  submitAndVerifyBinanceAlgoOrder,
  validateBinanceAlgoParameters,
  verifyBinanceAlgoOrder,
} = sourceModule.exports;

function responseFor(parameters, algoId = 123) {
  return {
    algoId,
    clientAlgoId: parameters.clientAlgoId,
    algoStatus: 'NEW',
    algoType: 'CONDITIONAL',
    symbol: parameters.symbol,
    side: parameters.side,
    positionSide: 'BOTH',
    orderType: parameters.type,
    ...(parameters.triggerPrice ? {
      triggerPrice: parameters.triggerPrice,
      closePosition: true,
      workingType: parameters.workingType,
    } : {
      activatePrice: parameters.activatePrice,
      callbackRate: parameters.callbackRate,
      quantity: parameters.quantity,
      reduceOnly: true,
      closePosition: false,
      workingType: parameters.workingType,
    }),
  };
}

function closeAllParameters(overrides = {}) {
  return buildCloseAllAlgoOrderParameters({
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: '95000.0',
    clientAlgoId: 'stop-client-1',
    ...overrides,
  });
}

const trailingParameters = {
  algoType: 'CONDITIONAL',
  symbol: 'BTCUSDT',
  side: 'SELL',
  type: 'TRAILING_STOP_MARKET',
  activatePrice: '101.25',
  callbackRate: '1',
  quantity: '0.125',
  reduceOnly: 'true',
  workingType: 'MARK_PRICE',
  positionSide: 'BOTH',
  clientAlgoId: 'trail-client-1',
};

test('close-all conditional payloads use triggerPrice and exclude quantity/reduceOnly', () => {
  const stop = closeAllParameters();
  const takeProfit = closeAllParameters({
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: '110000',
    clientAlgoId: 'tp3-client-1',
  });
  assert.deepEqual(stop, {
    algoType: 'CONDITIONAL',
    symbol: 'BTCUSDT',
    side: 'SELL',
    type: 'STOP_MARKET',
    triggerPrice: '95000.0',
    closePosition: 'true',
    workingType: 'MARK_PRICE',
    positionSide: 'BOTH',
    clientAlgoId: 'stop-client-1',
  });
  assert.equal(takeProfit.type, 'TAKE_PROFIT_MARKET');
  assert.equal('quantity' in stop, false);
  assert.equal('reduceOnly' in stop, false);
  assert.equal(validateBinanceAlgoParameters(stop).closePosition, 'true');
});

test('trailing Algo payload uses activatePrice and one-percent callbackRate', () => {
  assert.equal(validateBinanceAlgoParameters(trailingParameters).activatePrice, '101.25');
  assert.equal(trailingParameters.callbackRate, '1');
  assert.equal(Number(trailingParameters.callbackRate), 1);
  assert.equal('activationPrice' in trailingParameters, false);
});

test('validator rejects closePosition combined with quantity or reduceOnly', () => {
  const valid = closeAllParameters();
  assert.throws(
    () => validateBinanceAlgoParameters({ ...valid, quantity: '0.125' }),
    BinanceAlgoOrderError,
  );
  assert.throws(
    () => validateBinanceAlgoParameters({ ...valid, reduceOnly: 'true' }),
    /closePosition cannot be combined/,
  );
  assert.throws(
    () => validateBinanceAlgoParameters({ ...trailingParameters, activationPrice: '101.25' }),
    /TRAILING_STOP_MARKET/,
  );
  assert.throws(
    () => validateBinanceAlgoParameters({ ...trailingParameters, callbackRate: '0.01' }),
    /TRAILING_STOP_MARKET/,
  );
});

test('order verification requires complete One-way position and protection fields', () => {
  const expected = closeAllParameters();
  const order = responseFor(expected);
  assert.equal(verifyBinanceAlgoOrder(order, expected), '123');
  assert.equal(verifyBinanceAlgoOrder({ ...order, positionSide: 'LONG' }, expected), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, triggerPrice: '94000' }, expected), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, closePosition: false }, expected), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, quantity: '0.1' }, expected), null);
});

test('trailing response must match type, symbol, direction, activation, rate, quantity and reduceOnly', () => {
  const order = responseFor(trailingParameters);
  assert.equal(verifyBinanceAlgoOrder(order, trailingParameters), '123');
  assert.equal(verifyBinanceAlgoOrder({ ...order, activatePrice: '100' }, trailingParameters), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, callbackRate: '0.01' }, trailingParameters), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, quantity: '0.124' }, trailingParameters), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, reduceOnly: false }, trailingParameters), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, side: 'BUY' }, trailingParameters), null);
  assert.equal(verifyBinanceAlgoOrder({ ...order, positionSide: 'SHORT' }, trailingParameters), null);
});

test('Algo response precision is compared as decimal strings, not rounded floating-point values', () => {
  const expected = closeAllParameters({ triggerPrice: '0.00000000000011' });
  assert.equal(verifyBinanceAlgoOrder(responseFor(expected), expected), '123');
  assert.equal(
    verifyBinanceAlgoOrder({
      ...responseFor(expected, 124),
      triggerPrice: '0.00000000000012',
    }, expected),
    null,
  );
});

test('submission uses only the Algo endpoint and reconciles/persists algoId', async () => {
  const parameters = closeAllParameters();
  const calls = [];
  const adapter = {
    async request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      if (method === 'POST') return { algoId: 456 };
      return responseFor(parameters, 456);
    },
  };
  assert.equal(await submitAndVerifyBinanceAlgoOrder(adapter, parameters), '456');
  assert.deepEqual(calls, [
    { method: 'POST', endpoint: '/fapi/v1/algoOrder', payload: parameters },
    { method: 'GET', endpoint: '/fapi/v1/algoOrder', payload: { symbol: 'BTCUSDT', algoId: '456' } },
  ]);
  assert.equal('orderId' in calls[0].payload, false);
});

test('accepted POST without algoId reconciles by clientAlgoId without retry', async () => {
  const parameters = closeAllParameters();
  const calls = [];
  const adapter = {
    async request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      if (method === 'POST') return { success: true };
      return responseFor(parameters, 789);
    },
  };
  assert.equal(await submitAndVerifyBinanceAlgoOrder(adapter, parameters), '789');
  assert.deepEqual(calls.map((call) => [call.method, call.endpoint]), [
    ['POST', '/fapi/v1/algoOrder'],
    ['GET', '/fapi/v1/algoOrder'],
  ]);
  assert.deepEqual(calls[1].payload, { symbol: 'BTCUSDT', clientAlgoId: 'stop-client-1' });
});

test('POST network failure is queried by client ID and never blindly resubmitted', async () => {
  const parameters = closeAllParameters();
  const calls = [];
  const adapter = {
    async request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      if (method === 'POST') throw new Error('network timeout');
      return responseFor(parameters, 321);
    },
  };
  assert.equal(await submitAndVerifyBinanceAlgoOrder(adapter, parameters), '321');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(calls[1].payload, { symbol: 'BTCUSDT', clientAlgoId: 'stop-client-1' });
});

test('Algo query and cancellation use the documented endpoint and algoId', async () => {
  const calls = [];
  const adapter = {
    async request(method, endpoint, parameters) {
      calls.push({ method, endpoint, parameters });
      return method === 'GET' ? { algoId: '23' } : { code: 200 };
    },
  };
  await queryBinanceAlgoOrder(adapter, 'BTCUSDT', { clientAlgoId: 'stop-client-1' });
  await cancelBinanceAlgoOrder(adapter, 'BTCUSDT', '23');
  assert.deepEqual(calls, [
    {
      method: 'GET',
      endpoint: '/fapi/v1/algoOrder',
      parameters: { symbol: 'BTCUSDT', clientAlgoId: 'stop-client-1' },
    },
    {
      method: 'DELETE',
      endpoint: '/fapi/v1/algoOrder',
      parameters: { symbol: 'BTCUSDT', algoId: '23' },
    },
  ]);
});

test('open conditional orders are read from openAlgoOrders and duplicate identities fail closed', async () => {
  const parameters = closeAllParameters();
  const order = responseFor(parameters);
  const calls = [];
  const adapter = {
    async request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      return [order];
    },
  };
  const openOrders = await listOpenBinanceAlgoOrders(adapter, 'BTCUSDT');
  assert.equal(calls[0].endpoint, '/fapi/v1/openAlgoOrders');
  assert.equal(findUniqueOpenBinanceAlgoOrder(openOrders, '123', 'stop-client-1').algoId, 123);
  assert.equal(findUniqueOpenBinanceAlgoOrder([...openOrders, order], null, 'stop-client-1'), undefined);
  assert.equal(findUniqueOpenBinanceAlgoOrder([{ ...order, algoStatus: 'CANCELED' }], '123', null), undefined);
});

test('API errors during reconciliation remain explicit and do not cause another POST', async () => {
  const parameters = closeAllParameters();
  const calls = [];
  const adapter = {
    async request(method, endpoint, payload) {
      calls.push({ method, endpoint, payload });
      if (method === 'POST') throw new Error('Binance rejected Algo order');
      throw new Error('Algo query unavailable');
    },
  };
  await assert.rejects(submitAndVerifyBinanceAlgoOrder(adapter, parameters), /Algo query unavailable/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('a rejected Algo request is preserved when Binance confirms the client Algo ID is absent', async () => {
  const parameters = closeAllParameters();
  const adapter = {
    async request(method) {
      if (method === 'POST') throw new Error('Binance rejected conditional parameters');
      throw Object.assign(new Error('Algo order does not exist'), { exchangeCode: -2013 });
    },
  };
  await assert.rejects(
    submitAndVerifyBinanceAlgoOrder(adapter, parameters),
    /Binance rejected conditional parameters/,
  );
});
