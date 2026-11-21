import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
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

const { createAdminBybitDemoExecutionPort } = require('./admin-demo-bybit-adapter.ts');

import { credentials, scope, execution, positionRow, fixture } from './bybit-lifecycle-mock-fixture.mjs';

test('exposes read/preflight support but disables all Bybit Admin Demo lifecycle trading', () => {
  const { port } = fixture();
  assert.equal(port.provider, 'BYBIT');
  assert.equal(port.environment, 'DEMO');
  assert.equal(port.baseUrl, 'https://api-demo.bybit.com');
  assert.deepEqual(port.capabilities, {
    connectionTest: true,
    balance: true,
    instruments: true,
    positions: true,
    entryPreflight: true,
    marketEntry: false,
    limitEntry: false,
    stopLossProtection: false,
    takeProfitProtection: false,
    trailingProtection: false,
    reduceOnlyClose: false,
    reconciliation: false,
    adminLifecycle: false,
  });
});

test('preflight signs the isolated Demo host request and confirms one-way mode', async () => {
  const { port, calls } = fixture();
  const result = await port.preflight(scope, execution);
  assert.deepEqual(result, {
    ready: true,
    environment: 'DEMO',
    endpoint: 'https://api-demo.bybit.com',
    oneWayMode: true,
    symbolValid: true,
    quantityValid: true,
    accountReady: true,
    flat: true,
  });

  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url.origin, 'https://api-demo.bybit.com');
  assert.equal(url.pathname, '/v5/position/list');
  assert.equal(url.search, '?category=linear&symbol=BTCUSDT');
  assert.equal(init.redirect, 'error');
  const signedPayload = `${init.headers['X-BAPI-TIMESTAMP']}demo-key5000${url.search.slice(1)}`;
  assert.equal(
    init.headers['X-BAPI-SIGN'],
    createHmac('sha256', 'demo-secret').update(signedPayload).digest('hex'),
  );
  assert.equal(init.headers['X-BAPI-API-KEY'], 'demo-key');
});

test('preflight rejects hedge mode and open positions rather than treating them as one-way', async () => {
  const hedge = fixture({ rows: [positionRow({ positionIdx: 1, side: 'Buy', size: '0.01' })] });
  const hedgeResult = await hedge.port.preflight(scope, execution);
  assert.equal(hedgeResult.oneWayMode, false);
  assert.equal(hedgeResult.flat, false);
  assert.equal(hedgeResult.ready, false);
  await assert.rejects(hedge.port.assertEntryPreconditions(scope, execution), /execution is disabled/);

  const open = fixture({ rows: [positionRow({ side: 'Buy', size: '0.01' })] });
  const openResult = await open.port.preflight(scope, execution);
  assert.equal(openResult.oneWayMode, true);
  assert.equal(openResult.flat, false);
  assert.equal(openResult.ready, false);
});

test('read-only position mapping preserves SHORT sign and remains Admin Demo scoped', async () => {
  const { port } = fixture({ rows: [positionRow({ side: 'Sell', size: '0.02' })] });
  assert.deepEqual(await port.getPosition(scope, 'BTCUSDT'), { amount: '-0.02' });
  await assert.rejects(
    port.getAccountBalance({ ...scope, kind: 'CUSTOMER' }),
    /out-of-scope/,
  );
});

test('LONG and SHORT entries, protection, close, and reconciliation fail closed without exchange orders', async () => {
  const { port, calls, clientCalls } = fixture();
  for (const direction of ['LONG', 'SHORT']) {
    const request = {
      clientOrderId: `entry-${direction.toLowerCase()}`,
      execution: { ...execution, direction },
    };
    await assert.rejects(port.submitEntry(scope, request), /execution is disabled/);
    await assert.rejects(port.installProtection(scope, request.execution), /execution is disabled/);
    await assert.rejects(
      port.closePositionAndVerify(scope, request.execution),
      /execution is disabled/,
    );
    await assert.rejects(
      port.lookupEntry(scope, 'BTCUSDT', request.clientOrderId),
      /execution is disabled/,
    );
    await assert.rejects(
      port.cancelObsoleteProtection(scope, request.execution, {
        stopAlgoId: '1',
        tp3AlgoId: '2',
        trailingAlgoId: '3',
      }),
      /execution is disabled/,
    );
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(clientCalls, []);
});

function activePosition(direction = 'LONG', overrides = {}) {
  const isLong = direction === 'LONG';
  return {
    symbol: 'BTCUSDT',
    positionIdx: 0,
    side: isLong ? 'Buy' : 'Sell',
    size: '0.01',
    avgPrice: '1000',
    stopLoss: '0',
    takeProfit: '0',
    trailingStop: '0',
    tpslMode: 'Full',
    ...overrides,
  };
}

function executionFor(direction = 'LONG') {
  return direction === 'LONG'
    ? execution
    : {
      ...execution,
      direction: 'SHORT',
      stopPrice: '1100',
      tp1Price: '900',
      tp2Price: '800',
      tp3Price: '700',
    };
}

test('test-injected lifecycle enables only requested lifecycle capabilities', () => {
  const { port } = fixture({ executionEnabled: true });
  assert.deepEqual(port.capabilities, {
    connectionTest: true,
    balance: true,
    instruments: true,
    positions: true,
    entryPreflight: true,
    marketEntry: false,
    limitEntry: true,
    stopLossProtection: true,
    takeProfitProtection: true,
    trailingProtection: true,
    reduceOnlyClose: true,
    reconciliation: true,
    adminLifecycle: true,
  });
});

test('LONG and SHORT use one full-position SL, TP3, and a single TP1-activated trailing stop', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const active = activePosition(direction);
    const { port, clientCalls, state } = fixture({
      rows: [positionRow({ side: active.side, size: active.size })],
      positionDetails: active,
      executionEnabled: true,
    });
    const plan = executionFor(direction);
    const identifiers = await port.installProtection(scope, plan);
    assert.equal(state.position.stopLoss, plan.stopPrice);
    assert.equal(state.position.takeProfit, plan.tp3Price);
    assert.equal(state.position.trailingStop, '100');
    assert.equal(state.position.activePrice, undefined);
    assert.equal(state.position.tpslMode, 'Full');
    assert.equal(await port.verifyProtection(scope, plan, identifiers), true);
    assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
    assert.equal(clientCalls.filter(([name]) => name === 'getRealtimeTrailingStops').length, 3);
    assert.match(identifiers.stopAlgoId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.match(identifiers.tp3AlgoId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.match(identifiers.trailingAlgoId, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(identifiers.trailingAlgoId.includes('trail-tp1'), true);
  }
});

test('LIMIT entry is idempotent by client order ID and maps SHORT side correctly', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const { port, clientCalls } = fixture({ executionEnabled: true });
    const request = {
      clientOrderId: `entry-${direction.toLowerCase()}`,
      execution: executionFor(direction),
      entryPrice: direction === 'LONG' ? '1000' : '1000',
    };
    const first = await port.submitEntry(scope, request);
    const second = await port.submitEntry(scope, request);
    assert.deepEqual(second, first);
    assert.equal(first.status, 'NEW');
    assert.equal(clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);
    const [, submitted] = clientCalls.find(([name]) => name === 'placeLimitOrder');
    assert.equal(submitted.side, direction === 'LONG' ? 'BUY' : 'SELL');
  }
});

test('entry lookup and cancellation recover by the stable client order ID after timeout', async () => {
  const { port, clientCalls } = fixture({
    executionEnabled: true,
    cancelError: new Error('cancel request timed out'),
  });
  const request = { clientOrderId: 'entry-cancel', execution, entryPrice: '1000' };
  const submitted = await port.submitEntry(scope, request);
  assert.deepEqual(await port.lookupEntry(scope, 'BTCUSDT', request.clientOrderId), submitted);
  const canceled = await port.cancelEntry(scope, 'BTCUSDT', submitted.orderId);
  assert.equal(canceled.status, 'CANCELED');
  assert.deepEqual(await port.cancelEntry(scope, 'BTCUSDT', submitted.orderId), canceled);
  assert.equal(clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);
  assert.equal(clientCalls.filter(([name]) => name === 'cancelOrder').length, 1);
});

test('entry rejects hedge mode and quantity, price-tick, and minimum-notional violations', async () => {
  const hedge = fixture({
    rows: [positionRow({ positionIdx: 1, side: 'Buy' })],
    executionEnabled: true,
  });
  await assert.rejects(hedge.port.assertEntryPreconditions(scope, execution), /preconditions/);

  const invalidQuantity = fixture({ executionEnabled: true });
  const badQuantity = { ...execution, quantity: '0.0105' };
  assert.equal((await invalidQuantity.port.preflight(scope, badQuantity)).quantityValid, false);
  await assert.rejects(invalidQuantity.port.submitEntry(scope, {
    clientOrderId: 'bad-quantity',
    execution: badQuantity,
    entryPrice: '1000',
  }), /preconditions/);

  const invalidPrice = fixture({ executionEnabled: true });
  await assert.rejects(invalidPrice.port.submitEntry(scope, {
    clientOrderId: 'bad-tick',
    execution,
    entryPrice: '1000.05',
  }), /tick-size/);

  const belowMinimum = fixture({ executionEnabled: true });
  await assert.rejects(belowMinimum.port.submitEntry(scope, {
    clientOrderId: 'bad-notional',
    execution: { ...execution, quantity: '0.001' },
    entryPrice: '1000',
  }), /preconditions/);
});

test('entry submission recovers an accepted request after timeout without resubmitting', async () => {
  const timeout = new Error('request timed out');
  const recovered = fixture({
    executionEnabled: true,
    placeError: (input, state, sequence) => {
      state.orders.set(input.clientOrderId, {
        symbol: input.symbol,
        exchangeOrderId: String(sequence),
        clientOrderId: input.clientOrderId,
        side: input.side,
        type: 'Limit',
        status: 'New',
        quantity: input.quantity,
        filledQuantity: '0',
        price: input.price,
      });
      throw timeout;
    },
  });
  const result = await recovered.port.submitEntry(scope, {
    clientOrderId: 'timeout-entry',
    execution,
    entryPrice: '1000',
  });
  assert.equal(result.orderId, '1');
  assert.equal(recovered.clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);

  const rejected = fixture({ executionEnabled: true, placeError: new Error('exchange rejected order') });
  await assert.rejects(rejected.port.submitEntry(scope, {
    clientOrderId: 'rejected-entry',
    execution,
    entryPrice: '1000',
  }), /exchange rejected order/);
});

test('protection rejection and unverifiable or ambiguous trailing readback fail closed without removing SL/TP', async () => {
  const rejection = fixture({
    rows: [positionRow({ side: 'Buy', size: '0.01' })],
    positionDetails: activePosition('LONG', { stopLoss: '850', takeProfit: '1400' }),
    executionEnabled: true,
    protectionError: new Error('Bybit rejected trading-stop'),
  });
  await assert.rejects(rejection.port.installProtection(scope, execution), (error) => /existing protection retained/.test(error.message) && /rejected trading-stop/.test(error.cause?.message));
  assert.equal(rejection.state.position.stopLoss, '850');
  assert.equal(rejection.state.position.takeProfit, '1400');

  const unverifiable = fixture({
    rows: [positionRow({ side: 'Buy', size: '0.01' })],
    positionDetails: activePosition('LONG', { stopLoss: execution.stopPrice, takeProfit: execution.tp3Price }),
    executionEnabled: true,
    unverifiableProtection: true,
  });
  await assert.rejects(unverifiable.port.installProtection(scope, execution), /did not verify|ambiguous/);
  assert.equal(unverifiable.state.position.stopLoss, execution.stopPrice);
  assert.equal(unverifiable.state.position.takeProfit, execution.tp3Price);

  const ambiguous = fixture({
    rows: [positionRow({ side: 'Buy', size: '0.01' })],
    positionDetails: activePosition('LONG', { stopLoss: execution.stopPrice, takeProfit: execution.tp3Price }),
    executionEnabled: true,
    staleTrailingStops: [{
      symbol: 'BTCUSDT',
      orderId: 'stale-trailing',
      positionIdx: 0,
      stopOrderType: 'TrailingStop',
      triggerPrice: '1050',
      tpslMode: 'Full',
    }],
  });
  await assert.rejects(ambiguous.port.installProtection(scope, execution), /did not verify|ambiguous/);
  assert.equal(ambiguous.state.position.stopLoss, execution.stopPrice);
  assert.equal(ambiguous.state.position.takeProfit, execution.tp3Price);
});

test('close is reduce-only and requires a verified zero position; cleanup is flat-only', async () => {
  const active = activePosition('SHORT', { stopLoss: '1100', takeProfit: '700', trailingStop: '100' });
  const fixtureState = fixture({
    rows: [positionRow({ side: 'Sell', size: '0.01' })],
    positionDetails: active,
    executionEnabled: true,
  });
  const plan = executionFor('SHORT');
  const closed = await fixtureState.port.closePositionAndVerify(scope, plan);
  assert.equal(closed.closed, true);
  const closeCall = fixtureState.clientCalls.find(([name]) => name === 'placeMarketOrder');
  assert.equal(closeCall[1].side, 'BUY');
  assert.equal(closeCall[1].reduceOnly, true);
  await fixtureState.port.cancelObsoleteProtection(
    scope,
    plan,
    { stopAlgoId: `native-${scope.executionId}-sl`, tp3AlgoId: `native-${scope.executionId}-tp3`, trailingAlgoId: `native-${scope.executionId}-trail-tp1` },
  );
  assert.equal(fixtureState.clientCalls.some(([name]) => name === 'clearPositionProtection'), true);

  const unconfirmed = fixture({
    rows: [positionRow({ side: 'Buy', size: '0.01' })],
    positionDetails: activePosition('LONG', { stopLoss: '900' }),
    executionEnabled: true,
    closeLeavesPosition: true,
  });
  const result = await unconfirmed.port.closePositionAndVerify(scope, execution);
  assert.equal(result.closed, false);
  await assert.rejects(unconfirmed.port.cancelObsoleteProtection(
    scope,
    execution,
    { stopAlgoId: `native-${scope.executionId}-sl`, tp3AlgoId: `native-${scope.executionId}-tp3`, trailingAlgoId: `native-${scope.executionId}-trail-tp1` },
  ), /zero position/);
});

test('duplicate client IDs cannot mutate direction, quantity, or entry price', async () => {
  const { port, clientCalls } = fixture({ executionEnabled: true });
  const request = { clientOrderId: 'bound-entry', execution, entryPrice: '1000' };
  await port.submitEntry(scope, request);
  for (const conflicting of [
    { ...request, execution: executionFor('SHORT') },
    { ...request, execution: { ...execution, quantity: '0.02' } },
    { ...request, entryPrice: '1000.1' },
  ]) {
    await assert.rejects(port.submitEntry(scope, conflicting), /bound to a different entry/);
  }
  assert.equal(clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);
});

test('initial protection refuses an unrelated or partially filled position before writes', async () => {
  for (const mismatch of [{ side: 'Sell' }, { size: '0.005' }, { positionIdx: 1 }]) {
    const { port, clientCalls } = fixture({
      executionEnabled: true,
      positionDetails: activePosition('LONG', mismatch),
    });
    await assert.rejects(port.installProtection(scope, execution), /position|one-way/i);
    assert.equal(clientCalls.some(([name]) => name === 'setPositionLifecycleProtection'), false);
  }
});

test('entry validates the full ordered protection plan before submitting an order', async () => {
  for (const invalid of [
    { stopPrice: '1001' },
    { tp1Price: '1200' },
    { tp2Price: '1300' },
    { tp3Price: '1299.95' },
    { tickSize: '0.01' },
  ]) {
    const { port, clientCalls } = fixture({ executionEnabled: true });
    await assert.rejects(port.submitEntry(scope, {
      clientOrderId: 'invalid-plan', execution: { ...execution, ...invalid }, entryPrice: '1000',
    }));
    assert.equal(clientCalls.some(([name]) => name === 'placeLimitOrder'), false);
  }
});

test('cleanup rejects identifiers owned by another execution before protection removal', async () => {
  const { port, clientCalls } = fixture({ executionEnabled: true });
  await assert.rejects(port.cancelObsoleteProtection(scope, execution, {
    stopAlgoId: 'native-9002-sl', tp3AlgoId: 'native-9002-tp3', trailingAlgoId: 'native-9002-trail-tp1',
  }), /identifiers do not match/);
  assert.equal(clientCalls.some(([name]) => name === 'clearPositionProtection'), false);
});


test('TP1 and TP2 milestones retain one native trailing stop and never claim activation from price alone', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const { port, state, clientCalls } = fixture({
      executionEnabled: true, positionDetails: activePosition(direction),
    });
    const plan = executionFor(direction);
    await port.installProtection(scope, plan);
    state.tickerPrice = plan.tp1Price;
    const tp1 = await port.reconcileStagedProtection(scope, plan, { tp1Reached: false, tp2Reached: false });
    assert.deepEqual(tp1, { tp1Reached: true, tp2Reached: false, trailingActivated: false, tp2Update: 'NOT_REQUESTED' });
    state.tickerPrice = plan.tp2Price;
    const tp2 = await port.reconcileStagedProtection(scope, plan, tp1);
    assert.deepEqual(tp2, { tp1Reached: true, tp2Reached: true, trailingActivated: false, tp2Update: 'UNSUPPORTED_RETAINED' });
    state.tickerPrice = '1000';
    const recovered = await port.reconcileStagedProtection(scope, plan, tp2);
    assert.deepEqual(recovered, tp2);
    assert.equal(state.position.stopLoss, plan.stopPrice);
    assert.equal(state.trailingStops.length, 1);
    assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
    assert.equal(clientCalls.some(([name]) => name === 'clearPositionProtection'), false);
  }
});

test('stage reconciliation rejects missing native protection while retaining the initial SL', async () => {
  const { port, state, clientCalls } = fixture({ executionEnabled: true, positionDetails: activePosition() });
  await port.installProtection(scope, execution);
  state.trailingStops = [];
  state.tickerPrice = execution.tp2Price;
  await assert.rejects(port.reconcileStagedProtection(scope, execution, { tp1Reached: true, tp2Reached: false }), /protection|verify/i);
  assert.equal(state.position.stopLoss, execution.stopPrice);
  assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
  assert.equal(clientCalls.some(([name]) => name === 'clearPositionProtection'), false);
});

test('Bybit TP2 scan rejects changed native TP3 or trailing activation without mutating protection', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    for (const mismatch of ['takeProfit', 'activation']) {
      const { port, state, clientCalls } = fixture({
        executionEnabled: true,
        positionDetails: activePosition(direction),
      });
      const plan = executionFor(direction);
      const ids = await port.installProtection(scope, plan);
      state.tickerPrice = plan.tp2Price;
      if (mismatch === 'takeProfit') {
        state.position.takeProfit = plan.tp2Price;
      } else {
        state.trailingStops[0].triggerPrice = plan.tp2Price;
      }
      assert.equal(await port.verifyProtection(scope, plan, ids), false);
      await assert.rejects(
        port.reconcileStagedProtection(scope, plan, { tp1Reached: true, tp2Reached: false }),
        /protection|verify/i,
      );
      assert.equal(state.position.stopLoss, plan.stopPrice);
      assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
      assert.equal(clientCalls.some(([name]) => name === 'clearPositionProtection'), false);
      assert.equal(clientCalls.some(([name]) => name === 'placeMarketOrder'), false);
    }
  }
});




test('local lifecycle enablement requires injected mock transport and client', () => {
  assert.throws(() => createAdminBybitDemoExecutionPort(credentials, { executionEnabled: true }), /injected mock/i);
});

test('restart installation verifies existing native protection without adding a second trailing stop', async () => {
  const { port, state, clientCalls } = fixture({ executionEnabled: true, positionDetails: activePosition() });
  const first = await port.installProtection(scope, execution);
  const restarted = await port.installProtection(scope, execution);
  assert.deepEqual(restarted, first);
  assert.equal(state.trailingStops.length, 1);
  assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
});

test('accepted protection timeout recovers by readback without a duplicate native trailing write', async () => {
  const { port, clientCalls } = fixture({
    executionEnabled: true,
    positionDetails: activePosition(),
    protectionError(symbol, protection, state) {
      state.position = { ...state.position, ...protection, tpslMode: 'Full' };
      state.trailingStops = [{ symbol, orderId: 'accepted-trail', positionIdx: 0, stopOrderType: 'TrailingStop', triggerPrice: protection.activePrice, tpslMode: 'Full' }];
      throw new Error('accepted response timeout');
    },
  });
  const identifiers = await port.installProtection(scope, execution);
  assert.equal(await port.verifyProtection(scope, execution, identifiers), true);
  assert.equal(clientCalls.filter(([name]) => name === 'setPositionLifecycleProtection').length, 1);
});

test('actual Bybit adapter composes with shared lifecycle for LONG and SHORT entry through full close', async () => {
  const { createExecutionLifecycle } = require('./execution-lifecycle.ts');
  for (const direction of ['LONG', 'SHORT']) {
    const plan = executionFor(direction);
    const f = fixture({
      executionEnabled: true,
      placeError(input, state, sequence) {
        const order = { symbol: input.symbol, exchangeOrderId: String(sequence), clientOrderId: input.clientOrderId, side: input.side, type: 'Limit', status: 'Filled', quantity: input.quantity, filledQuantity: input.quantity, price: input.price };
        state.orders.set(input.clientOrderId, order);
        state.position = activePosition(direction, { stopLoss: input.initialProtection.stopLoss, takeProfit: input.initialProtection.takeProfit });
        return order;
      },
    });
    let saved = null;
    let closed = false;
    const lifecycle = createExecutionLifecycle({
      exchange: f.port,
      authorization: { async assertAuthorized(actual) { assert.deepEqual(actual, scope); } },
      environment: { async assertEnvironment(actual) { assert.equal(actual.environment, 'DEMO'); } },
      executions: { async assertScope() {}, async markProtected() {}, async markClosed() { closed = true; }, async markUncertain() { assert.fail('unexpected uncertain state'); } },
      entries: { async reserveEntry() { return 'CREATED'; }, async markEntryFilled() {}, async markEntryUncertain() { assert.fail('unexpected uncertain entry'); }, async markEntryFailed() { assert.fail('unexpected failed entry'); } },
      protections: { async loadProtectionIdentifiers() { return saved; }, async markProtectionVerified(actual, ids) { saved = ids; }, async markProtectionFailed() { assert.fail('unexpected protection failure'); } },
      reconciliation: { async claim() { return true; }, async release() {} },
      events: { async publish() {} },
    });
    const entered = await lifecycle.submitAndProtectEntry(scope, { clientOrderId: `integration-${direction}`, execution: plan, entryPrice: '1000' });
    assert.equal(entered.status, 'PROTECTED');
    assert.equal(f.state.position.stopLoss, plan.stopPrice);
    assert.equal(f.state.trailingStops.length, 1);
    const result = await lifecycle.reconcile(scope, plan, { tp1Reached: true, tp2Reached: true, tp3Reached: true, trailingActivated: false });
    assert.equal(result, 'CLOSED');
    assert.equal(closed, true);
    assert.equal(f.state.position.size, '0');
    assert.equal(f.state.position.stopLoss, '0');
    assert.equal(f.state.trailingStops.length, 0);
    const close = f.clientCalls.find(([name]) => name === 'placeMarketOrder')[1];
    assert.equal(close.reduceOnly, true);
    assert.equal(close.quantity, plan.quantity);
    assert.equal(close.side, direction === 'LONG' ? 'SELL' : 'BUY');
  }
});

test('terminal partial/rejected/cancelled closes replace only the freshly confirmed residual quantity', async () => {
  for (const status of ['Cancelled', 'Rejected', 'PartiallyFilledCanceled', 'Filled']) {
    const f = fixture({ executionEnabled: true, positionDetails: activePosition('LONG', { size: '0.004' }) });
    f.state.orders.set('admclose9001', { symbol: 'BTCUSDT', exchangeOrderId: 'close-1', clientOrderId: 'admclose9001',
      side: 'SELL', type: 'Market', status, quantity: '0.01', filledQuantity: '0.006', price: null });
    let checks = 0;
    f.port.bindMutationGuard(async () => { checks += 1; });
    assert.equal((await f.port.closePositionAndVerify(scope, execution)).closed, true);
    const close = f.clientCalls.find(([name]) => name === 'placeMarketOrder')[1];
    assert.equal(close.quantity, '0.004');
    assert.equal(close.reduceOnly, true);
    assert.notEqual(close.clientOrderId, 'admclose9001');
    assert.equal(checks, 1);
  }
});

test('working or unknown close never allocates a replacement and rejected replacement needs fresh authorization', async () => {
  for (const status of ['New', 'PartiallyFilled', 'Unknown', 'Rejected']) {
    const f = fixture({ executionEnabled: true, positionDetails: activePosition('LONG', { size: '0.004' }) });
    f.state.orders.set('admclose9001', { symbol: 'BTCUSDT', exchangeOrderId: 'close-1', clientOrderId: 'admclose9001',
      side: 'SELL', type: 'Market', status, quantity: '0.01', filledQuantity: '0.006', price: null });
    f.port.bindMutationGuard(async () => { throw new Error('authorization expired'); });
    if (status === 'Rejected') await assert.rejects(f.port.closePositionAndVerify(scope, execution), /authorization expired/);
    else assert.equal((await f.port.closePositionAndVerify(scope, execution)).closed, false);
    assert.equal(f.clientCalls.filter(([name]) => name === 'placeMarketOrder').length, 0);
  }
});

test('accepted timed-out residual close is recovered under its stable replacement ID without duplication', async () => {
  const f = fixture({ executionEnabled: true, positionDetails: activePosition('LONG', { size: '0.004' }) });
  f.state.orders.set('admclose9001', { symbol: 'BTCUSDT', exchangeOrderId: 'close-1', clientOrderId: 'admclose9001',
    side: 'SELL', type: 'Market', status: 'Cancelled', quantity: '0.01', filledQuantity: '0.006', price: null });
  let mutations = 0;
  f.client.placeMarketOrder = async input => {
    mutations += 1;
    f.state.orders.set(input.clientOrderId, { symbol: input.symbol, exchangeOrderId: 'close-2',
      clientOrderId: input.clientOrderId, side: input.side, type: 'Market', status: 'New',
      quantity: input.quantity, filledQuantity: '0', price: null });
    throw new Error('accepted timeout');
  };
  await assert.rejects(f.port.closePositionAndVerify(scope, execution), /accepted timeout/);
  assert.equal((await f.port.closePositionAndVerify(scope, execution)).closed, false);
  assert.equal(mutations, 1);
});

test('close replacement attempts are bounded and exhausted history cannot create another order', async () => {
  const f = fixture({ executionEnabled: true, positionDetails: activePosition('LONG', { size: '0.004' }) });
  const baseId = 'admclose9001';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = attempt === 0 ? baseId : `admclr${createHash('sha256').update(baseId).digest('hex').slice(0, 24)}-${attempt}`;
    f.state.orders.set(id, { symbol: 'BTCUSDT', exchangeOrderId: String(attempt + 1), clientOrderId: id,
      side: 'SELL', type: 'Market', status: 'Rejected', quantity: '0.004', filledQuantity: '0', price: null });
  }
  const result = await f.port.closePositionAndVerify(scope, execution);
  assert.equal(result.closed, false);
  assert.match(result.reason, /attempts exhausted/);
  assert.equal(f.clientCalls.filter(([name]) => name === 'placeMarketOrder').length, 0);
});
