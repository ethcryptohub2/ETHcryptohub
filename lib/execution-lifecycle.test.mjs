import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'execution-lifecycle.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const sourceModule = new Module(sourcePath);
sourceModule.filename = sourcePath;
sourceModule.paths = Module._nodeModulePaths(directory);
sourceModule._compile(compiled.outputText, sourcePath);
const {
  createAdminDemoExecutionLifecycle,
  createCustomerExecutionLifecycle,
  createExecutionLifecycle,
} = sourceModule.exports;

const customerScope = {
  kind: 'CUSTOMER',
  userId: 42,
  strategy: 'STANDARD',
  environment: 'DEMO',
  executionId: '101',
};
const adminScope = {
  kind: 'ADMIN_DEMO_TEST',
  adminUserId: 9,
  testAccountId: 'isolated-demo-1',
  sessionId: '9001',
  strategy: 'STANDARD',
  environment: 'DEMO',
  executionId: '9001',
  authorizationId: 'temporary-authorization-1',
};
const execution = {
  symbol: 'BTCUSDT',
  direction: 'LONG',
  quantity: '0.5',
  stopPrice: '90',
  tp2Price: '120',
  tp3Price: '130',
  tp1Price: '110',
  tickSize: '0.1',
};
const identifiers = {
  stopAlgoId: '11',
  tp3AlgoId: '12',
  trailingAlgoId: '13',
};
const entryRequest = { clientOrderId: 'entry-client-1', execution };

function fakePorts({
  expectedScope = customerScope,
  amount = '0.5',
  active = true,
  closeSucceeds = true,
  failPosition = false,
  failDatabase = false,
  authorizationError = null,
  environmentError = null,
  busy = false,
  entryOrder = { orderId: 'entry-1', status: 'FILLED', executedQuantity: '0.5' },
  entrySubmitError = null,
  entryLookupMissing = false,
  entryPreflightError = null,
  positionAfterEntry,
} = {}) {
  const state = {
    amount,
    active,
    closed: false,
    cancelled: false,
    closeCalls: 0,
    installs: 0,
    protectedWrites: 0,
    failureWrites: [],
    verifiedProgress: [],
    events: [],
    releases: 0,
    claims: 0,
    entrySubmissions: 0,
    entryLookups: 0,
    entryReservations: 0,
    entryUncertain: [],
    entryFailures: [],
    entryFilled: [],
    existingEntry: false,
  };
  function assertScope(scope) {
    assert.deepEqual(scope, expectedScope, 'repository scope must match exact owner, strategy, environment and record');
  }
  const dependencies = {
    authorization: {
      async assertAuthorized() {
        if (authorizationError) throw authorizationError;
      },
    },
    environment: {
      async assertEnvironment(scope) {
        if (environmentError) throw environmentError;
        if (scope.environment !== 'DEMO') throw new Error('Demo-only exchange port rejected non-Demo environment.');
      },
    },
    exchange: {
      async assertEntryPreconditions(scope) {
        assertScope(scope);
        if (entryPreflightError) throw entryPreflightError;
        if (Number(state.amount) !== 0) throw new Error('Isolated Demo account is not flat.');
      },
      async submitEntry(scope, request) {
        assertScope(scope);
        state.entrySubmissions += 1;
        assert.equal(request.execution.symbol, execution.symbol);
        if (entryOrder.executedQuantity !== '0') {
          state.amount = positionAfterEntry ?? (request.execution.direction === 'LONG'
            ? entryOrder.executedQuantity
            : `-${entryOrder.executedQuantity}`);
        }
        if (entrySubmitError) throw entrySubmitError;
        return entryOrder;
      },
      async lookupEntry(scope, symbol, clientOrderId) {
        assertScope(scope);
        assert.equal(symbol, execution.symbol);
        assert.equal(clientOrderId, 'entry-client-1');
        state.entryLookups += 1;
        return entryLookupMissing ? null : entryOrder;
      },
      async cancelEntry(scope, symbol, orderId) {
        assertScope(scope);
        assert.equal(symbol, execution.symbol);
        assert.equal(orderId, entryOrder.orderId);
        return { ...entryOrder, status: 'CANCELED' };
      },
      async installProtection(scope, input) {
        assertScope(scope);
        state.installs += 1;
        assert.match(input.quantity, /^\d+(?:\.\d+)?$/);
        return identifiers;
      },
      async verifyProtection(scope) {
        assertScope(scope);
        return state.active;
      },
      async getPosition(scope) {
        assertScope(scope);
        if (failPosition) throw new Error('mock exchange timeout');
        return { amount: state.amount };
      },
      async closePositionAndVerify(scope) {
        assertScope(scope);
        state.closeCalls += 1;
        if (closeSucceeds) {
          state.amount = '0';
          state.closed = true;
          return { closed: true };
        }
        return { closed: false, reason: 'Close outcome uncertain.' };
      },
      async cancelObsoleteProtection(scope) {
        assertScope(scope);
        assert.equal(Number(state.amount), 0, 'protection cannot be cancelled before position-zero verification');
        state.cancelled = true;
      },
    },
    executions: {
      async assertScope(scope) { assertScope(scope); },
      async markProtected(scope) {
        assertScope(scope);
        state.protectedWrites += 1;
        if (failDatabase) throw new Error('mock database unavailable');
      },
      async markClosed(scope) {
        assertScope(scope);
        state.closed = true;
      },
      async markUncertain(scope, reason) {
        assertScope(scope);
        state.failureWrites.push(reason);
      },
    },
    entries: {
      async reserveEntry(scope, request) {
        assertScope(scope);
        assert.equal(request.clientOrderId, 'entry-client-1');
        state.entryReservations += 1;
        if (busy) return 'BUSY';
        if (state.existingEntry) return 'EXISTING';
        state.existingEntry = true;
        return 'CREATED';
      },
      async markEntryUncertain(scope, reason) {
        assertScope(scope);
        state.entryUncertain.push(reason);
      },
      async markEntryFailed(scope, reason) {
        assertScope(scope);
        state.entryFailures.push(reason);
      },
      async markEntryFilled(scope, order, quantity) {
        assertScope(scope);
        state.entryFilled.push({ order, quantity });
      },
    },
    protections: {
      async loadProtectionIdentifiers(scope) {
        assertScope(scope);
        return identifiers;
      },
      async markProtectionVerified(scope, found, progress) {
        assertScope(scope);
        assert.deepEqual(found, identifiers);
        state.verifiedProgress.push(progress);
      },
      async markProtectionFailed(scope, reason) {
        assertScope(scope);
        state.failureWrites.push(reason);
      },
    },
    reconciliation: {
      async claim(scope) {
        assertScope(scope);
        state.claims += 1;
        return !busy;
      },
      async release(scope) {
        assertScope(scope);
        state.releases += 1;
      },
    },
    events: {
      async publish(event) {
        assertScope(event.scope);
        state.events.push(event.type);
      },
    },
  };
  return { dependencies, state };
}

function customerLifecycle(ports) {
  return createCustomerExecutionLifecycle(ports.dependencies, {
    async assertCustomerAuthorization(scope) {
      if (scope.kind !== 'CUSTOMER') throw new Error('Customer actor required.');
    },
  });
}

function adminLifecycle(ports, overrides = {}) {
  return createAdminDemoExecutionLifecycle(ports.dependencies, {
    async assertAdminRole() {
      if (overrides.admin !== true) throw new Error('Admin role required.');
    },
    async assertTemporaryAuthorization() {
      if (overrides.temporaryAuthorization !== true) throw new Error('Temporary Demo authorization required.');
    },
    async assertIsolatedDemoAccount(scope) {
      if (overrides.isolatedDemoAccount !== true || scope.testAccountId !== adminScope.testAccountId) {
        throw new Error('Isolated Demo test account required.');
      }
    },
  });
}

test('customer and Admin entry points call the same injected protection lifecycle', async () => {
  const customerPorts = fakePorts();
  const customer = customerLifecycle(customerPorts);
  const customerIds = await customer.protectOpenedPosition(customerScope, execution);
  assert.deepEqual(customerIds, identifiers);

  const adminPorts = fakePorts({ expectedScope: adminScope });
  const admin = adminLifecycle(adminPorts, { admin: true, temporaryAuthorization: true, isolatedDemoAccount: true });
  const adminIds = await admin.protectOpenedPosition(adminScope, execution);
  assert.deepEqual(adminIds, identifiers);
  assert.equal(customerPorts.state.installs, 1);
  assert.equal(adminPorts.state.installs, 1);
  assert.deepEqual(customerPorts.state.events, ['PROTECTION_VERIFIED']);
  assert.deepEqual(adminPorts.state.events, ['PROTECTION_VERIFIED']);
});

test('Admin entry rejects non-admin, missing temporary authorization, and non-isolated account', async () => {
  for (const options of [
    { admin: false, temporaryAuthorization: true, isolatedDemoAccount: true },
    { admin: true, temporaryAuthorization: false, isolatedDemoAccount: true },
    { admin: true, temporaryAuthorization: true, isolatedDemoAccount: false },
  ]) {
    const ports = fakePorts({ expectedScope: adminScope });
    const lifecycle = adminLifecycle(ports, options);
    await assert.rejects(lifecycle.protectOpenedPosition(adminScope, execution));
    assert.equal(ports.state.installs, 0);
  }
});

test('authorized Admin Demo reconciliation uses the shared TP3 close lifecycle', async () => {
  const ports = fakePorts({ expectedScope: adminScope });
  const lifecycle = adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  });
  const result = await lifecycle.reconcile(adminScope, execution, {
    tp1Reached: true,
    tp2Reached: true,
    tp3Reached: true,
    trailingActivated: true,
  });
  assert.equal(result, 'CLOSED');
  assert.equal(ports.state.closeCalls, 1);
  assert.equal(ports.state.cancelled, true);
  assert.deepEqual(ports.state.events, ['EXECUTION_CLOSED']);
});

test('Admin entry submits once, confirms the exact position, and uses the shared protection lifecycle', async () => {
  const ports = fakePorts({ expectedScope: adminScope, amount: '0' });
  const result = await adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(result.status, 'PROTECTED');
  assert.equal(ports.state.entrySubmissions, 1);
  assert.equal(ports.state.entryFilled[0].quantity, '0.5');
  assert.equal(ports.state.installs, 1);
  assert.equal(ports.state.protectedWrites, 1);
});

test('entry recovery looks up the original client ID and never submits a duplicate', async () => {
  const ports = fakePorts({ expectedScope: adminScope, amount: '0.5' });
  ports.state.existingEntry = true;
  const result = await adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(result.status, 'PROTECTED');
  assert.equal(ports.state.entrySubmissions, 0);
  assert.equal(ports.state.entryLookups, 1);

  const missing = fakePorts({ expectedScope: adminScope, amount: '0', entryLookupMissing: true });
  missing.state.existingEntry = true;
  const uncertain = await adminLifecycle(missing, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(uncertain.status, 'UNCERTAIN');
  assert.equal(missing.state.entrySubmissions, 0);
});

test('entry timeout reconciles by client ID without a second submission', async () => {
  const ports = fakePorts({
    expectedScope: adminScope,
    amount: '0',
    entrySubmitError: new Error('simulated timeout after exchange accepted request'),
  });
  const result = await adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(result.status, 'PROTECTED');
  assert.equal(ports.state.entrySubmissions, 1);
  assert.equal(ports.state.entryLookups, 1);

  const unknown = fakePorts({
    expectedScope: adminScope,
    amount: '0',
    entrySubmitError: new Error('timeout'),
    entryLookupMissing: true,
  });
  const unresolved = await adminLifecycle(unknown, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(unresolved.status, 'UNCERTAIN');
  assert.equal(unknown.state.entrySubmissions, 1);
  assert.equal(unknown.state.installs, 0);
});

test('partial fills are cancelled and protection covers the actual confirmed quantity', async () => {
  const ports = fakePorts({
    expectedScope: adminScope,
    amount: '0',
    entryOrder: { orderId: 'entry-1', status: 'PARTIALLY_FILLED', executedQuantity: '0.2' },
  });
  const result = await adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(result.status, 'PROTECTED');
  assert.equal(result.quantity, '0.2');
  assert.equal(ports.state.entryFilled[0].quantity, '0.2');
  assert.equal(ports.state.installs, 1);
});

test('entry preflight, position mismatch, and concurrent reservation fail closed', async () => {
  const blocked = fakePorts({
    expectedScope: adminScope,
    amount: '0',
    entryPreflightError: new Error('One-way mode required.'),
  });
  const blockedResult = await adminLifecycle(blocked, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(blockedResult.status, 'FAILED');
  assert.equal(blocked.state.entrySubmissions, 0);

  const mismatch = fakePorts({ expectedScope: adminScope, amount: '0', positionAfterEntry: '0.4' });
  const mismatchResult = await adminLifecycle(mismatch, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(mismatchResult.status, 'UNCERTAIN');
  assert.equal(mismatch.state.installs, 0);

  const busy = fakePorts({ expectedScope: adminScope, amount: '0', busy: true });
  const busyResult = await adminLifecycle(busy, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  }).submitAndProtectEntry(adminScope, entryRequest);
  assert.equal(busyResult.status, 'BUSY');
  assert.equal(busy.state.entrySubmissions, 0);
});

test('environment policy rejects Live or mismatched Demo credentials before exchange calls', async () => {
  const ports = fakePorts({ expectedScope: adminScope, environmentError: new Error('Demo credential environment is not confirmed.') });
  const admin = adminLifecycle(ports, {
    admin: true, temporaryAuthorization: true, isolatedDemoAccount: true,
  });
  await assert.rejects(admin.protectOpenedPosition(adminScope, execution), /credential environment/);
  assert.equal(ports.state.installs, 0);

  const service = createExecutionLifecycle(ports.dependencies);
  await assert.rejects(
    service.protectOpenedPosition({ ...adminScope, environment: 'LIVE' }, execution),
    /Execution scope is invalid/,
  );
});

test('repository rejects cross-user, cross-strategy, cross-environment and cross-record access', async () => {
  const ports = fakePorts();
  const lifecycle = customerLifecycle(ports);
  for (const changedScope of [
    { ...customerScope, userId: 43 },
    { ...customerScope, strategy: 'HIGH_RISK_SCALPING' },
    { ...customerScope, executionId: '102' },
  ]) {
    await assert.rejects(lifecycle.protectOpenedPosition(changedScope, execution), /exact owner/);
  }
  await assert.rejects(
    lifecycle.protectOpenedPosition({ ...customerScope, environment: 'LIVE' }, execution),
    /Demo-only exchange port rejected non-Demo environment/,
  );
  assert.equal(ports.state.installs, 0);
});

test('LONG and SHORT protected positions require exact signed full quantity', async () => {
  for (const [direction, amount] of [['LONG', '0.5'], ['SHORT', '-0.5']]) {
    const ports = fakePorts({ amount });
    const lifecycle = customerLifecycle(ports);
    await lifecycle.protectOpenedPosition(customerScope, { ...execution, direction });
    assert.equal(ports.state.protectedWrites, 1);
  }
  const wrongDirection = fakePorts({ amount: '-0.5' });
  await assert.rejects(
    customerLifecycle(wrongDirection).protectOpenedPosition(customerScope, execution),
    /not independently verified/,
  );
  assert.equal(wrongDirection.state.protectedWrites, 0);
});

test('TP1 and TP2 preserve full position and keep protection active without closing', async () => {
  const ports = fakePorts();
  const lifecycle = customerLifecycle(ports);
  assert.equal(await lifecycle.reconcile(customerScope, execution, {
    tp1Reached: true, tp2Reached: false, tp3Reached: false, trailingActivated: true,
  }), 'PROTECTED');
  assert.equal(await lifecycle.reconcile(customerScope, execution, {
    tp1Reached: true, tp2Reached: true, tp3Reached: false, trailingActivated: true,
  }), 'PROTECTED');
  assert.equal(ports.state.closeCalls, 0);
  assert.equal(ports.state.amount, '0.5');
  assert.deepEqual(ports.state.verifiedProgress, [
    { tp1Reached: true, tp2Reached: false, trailingActivated: true },
    { tp1Reached: true, tp2Reached: true, trailingActivated: true },
  ]);
});

test('TP3 closes full position and removes protection only after zero is confirmed', async () => {
  const ports = fakePorts();
  const lifecycle = customerLifecycle(ports);
  assert.equal(await lifecycle.reconcile(customerScope, execution, {
    tp1Reached: true, tp2Reached: true, tp3Reached: true, trailingActivated: true,
  }), 'CLOSED');
  assert.equal(ports.state.amount, '0');
  assert.equal(ports.state.cancelled, true);
  assert.equal(ports.state.closed, true);
  assert.equal(ports.state.closeCalls, 1);
});

test('restart and duplicate reconciliation are idempotent and always release the lease', async () => {
  const ports = fakePorts();
  const firstProcess = customerLifecycle(ports);
  const secondProcess = customerLifecycle(ports);
  assert.equal(await firstProcess.reconcile(customerScope, execution, {
    tp1Reached: false, tp2Reached: false, tp3Reached: false, trailingActivated: false,
  }), 'PROTECTED');
  assert.equal(await secondProcess.reconcile(customerScope, execution, {
    tp1Reached: false, tp2Reached: false, tp3Reached: false, trailingActivated: false,
  }), 'PROTECTED');
  assert.equal(ports.state.closeCalls, 0);
  assert.equal(ports.state.releases, 2);

  const busyPorts = fakePorts({ busy: true });
  assert.equal(await customerLifecycle(busyPorts).reconcile(customerScope, execution, {
    tp1Reached: false, tp2Reached: false, tp3Reached: false, trailingActivated: false,
  }), 'BUSY');
  assert.equal(busyPorts.state.releases, 0);
});

test('timeout, uncertain close, and database failure do not cancel valid protection', async () => {
  const timeoutPorts = fakePorts({ failPosition: true });
  await assert.rejects(customerLifecycle(timeoutPorts).protectOpenedPosition(customerScope, execution), /mock exchange timeout/);
  assert.equal(timeoutPorts.state.cancelled, false);

  const closePorts = fakePorts({ closeSucceeds: false });
  assert.equal(await customerLifecycle(closePorts).reconcile(customerScope, execution, {
    tp1Reached: false, tp2Reached: false, tp3Reached: true, trailingActivated: false,
  }), 'UNCERTAIN');
  assert.equal(closePorts.state.cancelled, false);
  assert.equal(closePorts.state.failureWrites.length > 0, true);

  const databasePorts = fakePorts({ failDatabase: true });
  await assert.rejects(customerLifecycle(databasePorts).protectOpenedPosition(customerScope, execution), /mock database unavailable/);
  assert.equal(databasePorts.state.cancelled, false);
});

test('Emergency Stop authorization blocks lifecycle calls before exchange access', async () => {
  const ports = fakePorts({ authorizationError: new Error('Emergency Stop is active.') });
  await assert.rejects(customerLifecycle(ports).protectOpenedPosition(customerScope, execution), /Emergency Stop/);
  assert.equal(ports.state.installs, 0);
});

test('position zero permits cleanup and close marking after restart', async () => {
  const ports = fakePorts({ amount: '0' });
  const result = await customerLifecycle(ports).reconcile(customerScope, execution, {
    tp1Reached: false, tp2Reached: false, tp3Reached: false, trailingActivated: false,
  });
  assert.equal(result, 'CLOSED');
  assert.equal(ports.state.cancelled, true);
  assert.equal(ports.state.closed, true);
});
