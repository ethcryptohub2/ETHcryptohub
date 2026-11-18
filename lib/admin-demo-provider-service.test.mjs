import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { fixture as bybitFixture } from './bybit-lifecycle-mock-fixture.mjs';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'server-only') return {};
  if (request === './admin-demo-provider-security' &&
      parent?.filename.endsWith('admin-demo-provider-service.ts')) {
    return {
      assertAdminDemoProviderActor(actor) {
        if (!actor || actor.role !== 'admin' || actor.is_active !== 1 || actor.id < 1) {
          throw new Error('Administrator access is required.');
        }
      },
      assertAdminDemoProviderEnvironment(provider, environment) {
        const fixed = { BINANCE: 'DEMO', BYBIT: 'DEMO', OKX: 'DEMO', BITGET: 'DEMO', GATE: 'TESTNET' };
        if (fixed[provider] !== environment) throw new Error('Fixed provider environment mismatch.');
      },
      assertAdminDemoProviderCapability(capabilities, capability) {
        if (capabilities?.[capability] !== true) throw new Error(`Capability ${capability} unavailable.`);
      },
    };
  }
  if (request === './admin-demo-staging-policy' &&
      parent?.filename.endsWith('admin-demo-provider-service.ts')) {
    return { isApprovedAdminDemoStagingTarget: () => false };
  }
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
  createAdminDemoProviderService,
  createServerAdminDemoProviderService,
} = Module.createRequire(import.meta.url)('./admin-demo-provider-service.ts');
const providers = ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'];
const environments = { BINANCE: 'DEMO', BYBIT: 'DEMO', OKX: 'DEMO', BITGET: 'DEMO', GATE: 'TESTNET' };
const actor = { id: 21, role: 'admin', is_active: 1 };
const secretValues = {
  apiKey: 'secret-api-key',
  apiSecret: 'secret-api-secret',
  passphrase: 'secret-passphrase',
};
const capabilities = (preflight = false) => ({
  connectionTest: true,
  balance: true,
  instruments: true,
  positions: true,
  entryPreflight: preflight,
  marketEntry: false,
  limitEntry: false,
  stopLossProtection: false,
  takeProfitProtection: false,
  trailingProtection: false,
  reduceOnlyClose: false,
  reconciliation: false,
  adminLifecycle: false,
});
const balances = [{
  asset: 'USDT',
  walletBalance: '100',
  availableBalance: '90',
  equity: '100',
  unrealizedPnl: '0',
}];
const instruments = [{
  exchangeSymbol: 'BTCUSDT',
  smartExitSymbol: 'BTCUSDT',
  contractType: 'PERPETUAL',
  quoteAsset: 'USDT',
  status: 'TRADING',
  tickSize: '0.1',
  quantityStep: '0.001',
  minimumQuantity: '0.001',
  maximumQuantity: '100',
  minimumNotional: '5',
  contractSize: '1',
  maximumLeverage: 100,
}];
const positions = [];

function fixture({
  overrideAdapters = {},
  credentialsEnabled = false,
  bybitAdapter,
  bybitLifecycleEnabledForTests = false,
  repositoryOverrides = {},
} = {}) {
  const calls = [];
  const exchangeCalls = [];
  const credentials = new Map(providers.filter((provider) => provider !== 'BITGET').map((provider) => [
    provider,
    {
      id: `${provider}-credential`,
      adminUserId: actor.id,
      provider,
      environment: environments[provider],
      ...secretValues,
      ownerConfirmedAt: '2026-01-01T00:00:00Z',
      enabled: credentialsEnabled,
      revokedAt: null,
    },
  ]));
  const statuses = providers.map((provider) => ({
    provider,
    environment: environments[provider],
    configured: provider !== 'BITGET',
    ownerConfirmed: provider !== 'BITGET',
    enabled: provider !== 'BITGET' && credentialsEnabled,
    revokedAt: null,
    createdAt: null,
    updatedAt: null,
  }));
  const repository = {
    async listCredentialStatuses(adminUserId) {
      calls.push(['listCredentialStatuses', adminUserId]);
      return statuses;
    },
    async getCredentialStatus(adminUserId, provider) {
      calls.push(['getCredentialStatus', adminUserId, provider]);
      return statuses.find((item) => item.provider === provider);
    },
    async getCredential(adminUserId, provider) {
      calls.push(['getCredential', adminUserId, provider]);
      return credentials.get(provider) ?? null;
    },
    async saveCredential(adminUserId, provider, input) {
      calls.push(['saveCredential', adminUserId, provider, input]);
      return {
        ...statuses.find((item) => item.provider === provider),
        configured: true,
        ownerConfirmed: true,
        enabled: false,
      };
    },
    async revokeCredential(adminUserId, provider) {
      calls.push(['revokeCredential', adminUserId, provider]);
      return true;
    },
    async listSessions(adminUserId, provider, limit) {
      calls.push(['listSessions', adminUserId, provider, limit]);
      return [];
    },
    async createSession(adminUserId, provider, input) {
      calls.push(['createSession', adminUserId, provider, input]);
      return { id: '1', adminUserId, provider, environment: environments[provider], credentialId: 'c', status: 'CREATED' };
    },
    async getSession() { return null; },
    async createAuthorization(...args) {
      calls.push(['createAuthorization', ...args]);
      throw new Error('must not create authorization');
    },
    async renewReconciliationAuthorization(...args) {
      calls.push(['renewReconciliationAuthorization', ...args]);
      throw new Error('must not renew authorization');
    },
    async revokeAuthorization() { return true; },
    async authorizeAction() { return false; },
    async reserveExecution() {
      calls.push(['reserveExecution']);
      throw new Error('must not reserve execution');
    },
    async updateExecutionStatus() { throw new Error('must not update execution'); },
    async listExecutions(adminUserId, provider, limit) {
      calls.push(['listExecutions', adminUserId, provider, limit]);
      return [];
    },
    async listAuditEvents(adminUserId, provider, limit) {
      calls.push(['listAuditEvents', adminUserId, provider, limit]);
      return [];
    },
    async appendAuditEvent() {},
    ...repositoryOverrides,
  };
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(['transport', url, init]);
    if (url.pathname === '/fapi/v3/account') {
      return Response.json({
        canTrade: true,
        assets: [{
          asset: 'USDT',
          balance: '100',
          crossWalletBalance: '100',
          crossUnPnl: '0',
          availableBalance: '90',
          marginBalance: '100',
        }],
      });
    }
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([]);
    if (url.pathname === '/fapi/v1/exchangeInfo') {
      return Response.json({
        symbols: [{
          symbol: 'BTCUSDT',
          status: 'TRADING',
          contractType: 'PERPETUAL',
          quoteAsset: 'USDT',
          filters: [
            { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' },
            { filterType: 'PRICE_FILTER', tickSize: '0.1' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        }],
      });
    }
    throw new Error(`Unexpected exchange request: ${url.href}`);
  };
  const readAdapter = (provider, environment, preflight = false) => ({
    provider,
    environment,
    capabilities: capabilities(preflight),
    async testConnection() { exchangeCalls.push(`${provider}:testConnection`); },
    async getAccountBalance() { exchangeCalls.push(`${provider}:balance`); return balances; },
    async getMarketInstruments() { exchangeCalls.push(`${provider}:instruments`); return instruments; },
    async getPositions() { exchangeCalls.push(`${provider}:positions`); return positions; },
    ...(preflight ? { async preflight() { exchangeCalls.push(`${provider}:preflight`); return { ready: true }; } } : {}),
  });
  const service = createAdminDemoProviderService({
    repository,
    transport,
    createBybitAdapter(input, options) {
      calls.push(['createBybitAdapter', input, options]);
      if (bybitAdapter) return bybitAdapter;
      return {
        ...readAdapter('BYBIT', 'DEMO', true),
        baseUrl: 'https://api-demo.bybit.com',
        async testConnection(scope) {
          assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
          exchangeCalls.push('BYBIT:testConnection');
        },
        async getAccountBalance(scope) {
          assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
          exchangeCalls.push('BYBIT:balance');
          return balances;
        },
        async getMarketInstruments(scope) {
          assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
          exchangeCalls.push('BYBIT:instruments');
          return instruments;
        },
        async getPositions(scope) {
          assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
          exchangeCalls.push('BYBIT:positions');
          return positions;
        },
        async preflight(scope, input) {
          assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
          exchangeCalls.push('BYBIT:preflight');
          return { ...input, ready: true };
        },
      };
    },
    createOkxAdapter(input, injectedTransport) {
      calls.push(['createOkxAdapter', input, injectedTransport]);
      return overrideAdapters.OKX ?? {
        ...readAdapter('OKX', 'DEMO'),
        exchange: 'OKX',
      };
    },
    createGateAdapter(input, environment, injectedTransport) {
      calls.push(['createGateAdapter', input, environment, injectedTransport]);
      return overrideAdapters.GATE ?? {
        ...readAdapter('GATE', 'TESTNET'),
        exchange: 'GATE',
      };
    },
    ...(bybitLifecycleEnabledForTests ? { bybitLifecycleEnabledForTests: true } : {}),
  });
  return { service, repository, calls, exchangeCalls, transport };
}

function lifecycleCapabilities() {
  return {
    ...capabilities(true),
    marketEntry: true,
    limitEntry: true,
    stopLossProtection: true,
    takeProfitProtection: true,
    trailingProtection: true,
    reduceOnlyClose: true,
    reconciliation: true,
    adminLifecycle: true,
  };
}

function mockLifecycleRepository({ initialStatus = 'CREATED' } = {}) {
  const events = [];
  const calls = [];
  let saved = null;
  const repositoryOverrides = {
    async authorizeAction() { return true; },
    async verifyReconciliationLease() { return true; },
    async claimReconciliation() { return true; },
    async releaseReconciliation() { return true; },
    async reserveExecution(adminUserId, provider, input) {
      calls.push(['reserveExecution', adminUserId, provider, input]);
      if (saved) return 'EXISTING';
      saved = {
        id: '801',
        sessionId: input.sessionId,
        authorizationId: input.authorizationId,
        adminUserId,
        provider,
        environment: 'DEMO',
        symbol: input.symbol,
        direction: input.direction,
        entryOrderType: input.entryOrderType,
        executionStatus: initialStatus,
        protectionStatus: 'PENDING',
        entryClientOrderId: input.entryClientOrderId,
        entryExchangeOrderId: null,
        quantity: input.quantity,
        entryPrice: input.entryPrice,
        stopLoss: input.stopLoss,
        tp1Price: input.tp1Price,
        tp2Price: input.tp2Price,
        tp3Price: input.tp3Price,
        tickSize: input.tickSize,
        stopClientOrderId: input.stopClientOrderId,
        tp3ClientOrderId: input.tp3ClientOrderId,
        trailingClientOrderId: input.trailingClientOrderId,
        stopProtectionId: null,
        tp3ProtectionId: null,
        trailingProtectionId: null,
        tp1ReachedAt: null,
        tp2ReachedAt: null,
        executionMode: 'CONFIRM',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        closedAt: null,
      };
      return 'CREATED';
    },
    async getExecution(adminUserId, provider, sessionId) {
      calls.push(['getExecution', adminUserId, provider, sessionId]);
      return saved?.adminUserId === adminUserId && saved.provider === provider &&
        saved.sessionId === sessionId ? { ...saved } : null;
    },
    async updateExecutionProgress(adminUserId, provider, sessionId, update, authorizationId) {
      calls.push(['updateExecutionProgress', adminUserId, provider, sessionId, update, authorizationId]);
      assert.equal(saved?.authorizationId, authorizationId);
      if (update.executionStatus) saved.executionStatus = update.executionStatus;
      if (update.protectionStatus) saved.protectionStatus = update.protectionStatus;
      if (update.filledQuantity) saved.quantity = update.filledQuantity;
      if (update.entryExchangeOrderId) saved.entryExchangeOrderId = update.entryExchangeOrderId;
      if (update.stopProtectionId) saved.stopProtectionId = update.stopProtectionId;
      if (update.tp3ProtectionId) saved.tp3ProtectionId = update.tp3ProtectionId;
      if (update.trailingProtectionId) saved.trailingProtectionId = update.trailingProtectionId;
      if (update.tp1Reached) saved.tp1ReachedAt ??= '2026-01-01T00:01:00.000Z';
      if (update.tp2Reached) saved.tp2ReachedAt ??= '2026-01-01T00:02:00.000Z';
      return { ...saved };
    },
    async appendAuditEvent(event) { events.push(event); },
  };
  return { repositoryOverrides, calls, events, getExecution: () => saved };
}

function mockLifecycleAdapter(exchangeCalls, overrides = {}) {
  return {
    provider: 'BYBIT',
    environment: 'DEMO',
    baseUrl: 'https://api-demo.bybit.com',
    capabilities: lifecycleCapabilities(),
    async assertEntryPreconditions(scope) {
      assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
      exchangeCalls.push('BYBIT:assertEntryPreconditions');
    },
    async submitEntry(scope, request) {
      assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
      exchangeCalls.push(['BYBIT:submitEntry', request.clientOrderId]);
      return { orderId: 'exchange-entry-1', status: 'FILLED', executedQuantity: '0.01' };
    },
    async lookupEntry(scope, symbol, clientOrderId) {
      assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
      exchangeCalls.push(['BYBIT:lookupEntry', symbol, clientOrderId]);
      return null;
    },
    async cancelEntry() {
      throw new Error('unexpected cancellation');
    },
    async installProtection() {
      exchangeCalls.push('BYBIT:installProtection');
      return {
        stopAlgoId: 'stop-protection-1',
        tp3AlgoId: 'tp3-protection-1',
        trailingAlgoId: 'trailing-protection-1',
      };
    },
    async verifyProtection() {
      exchangeCalls.push('BYBIT:verifyProtection');
      return true;
    },
    async getPosition() {
      exchangeCalls.push('BYBIT:getPosition');
      return { amount: '0.01' };
    },
    async closePositionAndVerify() {
      exchangeCalls.push('BYBIT:closePositionAndVerify');
      return { closed: true };
    },
    async cancelObsoleteProtection() {
      exchangeCalls.push('BYBIT:cancelObsoleteProtection');
    },
    async getTicker(scope, symbol) {
      assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
      exchangeCalls.push(['BYBIT:getTicker', symbol]);
      return { symbol, lastPrice: '1050', markPrice: '1050' };
    },
    ...overrides,
  };
}

function actualBybitService({ direction = 'LONG', repositoryOverrides = {} } = {}) {
  const state = mockLifecycleRepository();
  const exchange = bybitFixture({ accountId: String(actor.id), executionEnabled: true,
    placeError(input, native, sequence) {
      const order = { symbol: input.symbol, exchangeOrderId: String(sequence), clientOrderId: input.clientOrderId,
        side: input.side, type: 'Limit', status: 'Filled', quantity: input.quantity, filledQuantity: input.quantity, price: input.price };
      native.orders.set(input.clientOrderId, order);
      native.position = { symbol: input.symbol, positionIdx: 0, side: input.side === 'BUY' ? 'Buy' : 'Sell',
        size: input.quantity, avgPrice: input.price, stopLoss: input.initialProtection.stopLoss,
        takeProfit: input.initialProtection.takeProfit, trailingStop: '0', tpslMode: 'Full' };
      return order;
    },
  });
  let owner = null;
  const repository = {
    ...reconciliationRepositoryOverrides(state),
    async claimReconciliation(admin, provider, session, authorization, token) {
      if (owner) return false;
      owner = token;
      return true;
    },
    async verifyReconciliationLease(admin, provider, session, authorization, token) { return owner === token; },
    async releaseReconciliation(admin, provider, session, token) { if (owner === token) owner = null; return true; },
    ...repositoryOverrides,
  };
  const service = fixture({ credentialsEnabled: true, bybitAdapter: exchange.port,
    bybitLifecycleEnabledForTests: true, repositoryOverrides: repository }).service;
  const input = { sessionId: '501', authorizationId: '702', idempotencyKey: 'actual-service',
    confirmation: 'PLACE_ADMIN_DEMO_ORDER', entryOrderType: 'LIMIT', config: {
      symbol: 'BTCUSDT', direction, quantity: '0.01', entryPrice: '1000', tickSize: '0.1',
      stopLoss: direction === 'LONG' ? '900' : '1100', tp1Price: direction === 'LONG' ? '1100' : '900',
      tp2Price: direction === 'LONG' ? '1200' : '800', tp3Price: direction === 'LONG' ? '1300' : '700',
    } };
  return { service, exchange, state, input };
}

test('real Bybit adapter through Admin service supports LIMIT-only LONG/SHORT full lifecycle', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const f = actualBybitService({ direction });
    assert.equal(f.exchange.port.capabilities.marketEntry, false);
    assert.equal((await f.service.execute(actor, 'BYBIT', f.input)).result.status, 'PROTECTED');
    assert.equal(f.exchange.state.position.stopLoss, f.input.config.stopLoss);
    f.exchange.state.tickerPrice = f.input.config.tp1Price;
    assert.equal((await f.service.reconcile(actor, 'BYBIT', '501', '702')).result, 'PROTECTED');
    f.exchange.state.tickerPrice = f.input.config.tp2Price;
    assert.equal((await f.service.reconcile(actor, 'BYBIT', '501', '702')).limitation, 'TP2_TRAILING_UPDATE_UNSUPPORTED');
    f.exchange.state.tickerPrice = f.input.config.tp3Price;
    assert.equal((await f.service.reconcile(actor, 'BYBIT', '501', '702')).result, 'CLOSED');
    assert.equal(f.exchange.state.position.size, '0');
    assert.equal(f.exchange.state.trailingStops.length, 0);
  }
});

test('missing/partial protection IDs recover exchange coverage or emergency-close missing coverage', async () => {
  for (const nativeCovered of [true, false]) {
    const f = actualBybitService();
    await f.service.execute(actor, 'BYBIT', f.input);
    Object.assign(f.state.getExecution(), { executionStatus: 'RECONCILIATION_REQUIRED',
      tp3ProtectionId: null, trailingProtectionId: null });
    if (!nativeCovered) f.exchange.state.position.stopLoss = '0';
    const result = await f.service.reconcile(actor, 'BYBIT', '501', '702');
    assert.equal(result.result, nativeCovered ? 'PROTECTED' : 'CLOSED');
    assert.equal(f.exchange.clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);
    assert.equal(f.exchange.clientCalls.filter(([name]) => name === 'placeMarketOrder').length, nativeCovered ? 0 : 1);
  }
});

test('initial execution lease excludes concurrent execute and recovery workers', async () => {
  const f = actualBybitService();
  let resume;
  let entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const original = f.exchange.client.getMarketInstruments;
  f.exchange.client.getMarketInstruments = async () => { entered(); await gate; return original(); };
  const first = f.service.execute(actor, 'BYBIT', f.input);
  await paused;
  assert.equal((await f.service.execute(actor, 'BYBIT', f.input)).result.status, 'BUSY');
  assert.equal((await f.service.reconcile(actor, 'BYBIT', '501', '702')).status, 'BUSY');
  resume();
  assert.equal((await first).result.status, 'PROTECTED');
  assert.equal(f.exchange.clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 1);
});

test('authorization/lease expiry during actual adapter reads prevents entry mutation', async () => {
  for (const expireAuthorization of [true, false]) {
    let current = true;
    const f = actualBybitService({ repositoryOverrides: {
      async authorizeAction() { return expireAuthorization ? current : true; },
      async verifyReconciliationLease() { return expireAuthorization ? true : current; },
    } });
    const original = f.exchange.client.reconcileOrder;
    f.exchange.client.reconcileOrder = async (...args) => { current = false; return original(...args); };
    const result = await f.service.execute(actor, 'BYBIT', f.input);
    assert.equal(result.result.status, 'UNCERTAIN');
    assert.equal(f.exchange.clientCalls.filter(([name]) => name === 'placeLimitOrder').length, 0);
  }
});

test('Admin recovery closes a confirmed residual position without requiring the original full quantity', async () => {
  const f = actualBybitService();
  await f.service.execute(actor, 'BYBIT', f.input);
  f.exchange.state.position.size = '0.004';
  f.exchange.state.tickerPrice = f.input.config.tp3Price;
  assert.equal((await f.service.reconcile(actor, 'BYBIT', '501', '702')).result, 'CLOSED');
  const close = f.exchange.clientCalls.find(([name]) => name === 'placeMarketOrder')[1];
  assert.equal(close.quantity, '0.004');
  assert.equal(close.reduceOnly, true);
});

test('provider listing and adapter initialization preserve fixed endpoint/environment boundaries', async () => {
  const { service, calls, transport } = fixture();
  const listed = await service.listProviders(actor);
  assert.deepEqual(listed.map((entry) => [entry.provider, entry.environment]), providers.map((provider) => [
    provider,
    environments[provider],
  ]));
  assert.equal(listed.find((entry) => entry.provider === 'BITGET').capabilities.connectionTest, false);

  await service.testConnection(actor, 'BINANCE');
  assert.equal(calls.find((entry) => entry[0] === 'transport')[1].origin, 'https://demo-fapi.binance.com');
  await service.testConnection(actor, 'BYBIT');
  const bybit = calls.find((entry) => entry[0] === 'createBybitAdapter');
  assert.equal(bybit[1].environment, 'DEMO');
  assert.equal(bybit[1].testAccountId, String(actor.id));
  assert.equal(bybit[2].transport, transport);
  assert.equal(bybit[2].executionEnabled, false);

  await service.testConnection(actor, 'OKX');
  const okx = calls.find((entry) => entry[0] === 'createOkxAdapter');
  assert.equal(okx[1].apiKey, secretValues.apiKey);
  assert.equal(okx[2], transport);
  await service.testConnection(actor, 'GATE');
  const gate = calls.find((entry) => entry[0] === 'createGateAdapter');
  assert.equal(gate[2], 'TESTNET');
  assert.equal(gate[3], transport);
});

test('wrong provider environments are rejected before invoking injected exchange adapters', async () => {
  const wrongOkx = fixture({
    overrideAdapters: { OKX: { ...fixture().service, exchange: 'OKX', environment: 'LIVE' } },
  });
  await assert.rejects(wrongOkx.service.testConnection(actor, 'OKX'), /pinned to the Demo environment/);

  const wrongGate = fixture({
    overrideAdapters: { GATE: { exchange: 'GATE', environment: 'DEMO' } },
  });
  await assert.rejects(wrongGate.service.testConnection(actor, 'GATE'), /pinned to TESTNET/);
  assert.equal(wrongOkx.exchangeCalls.length, 0);
  assert.equal(wrongGate.exchangeCalls.length, 0);
});

test('non-admin users are denied before repository access', async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    service.listProviders({ id: 22, role: 'user', is_active: 1 }),
    /Administrator access is required/,
  );
  assert.equal(calls.length, 0);
});

test('production server service fails closed outside an approved staging target', async () => {
  await assert.rejects(
    createServerAdminDemoProviderService(),
    /outside an approved staging target/,
  );
});

test('test-only execution enablement requires injected adapter and transport mocks', async () => {
  const { repository } = fixture();
  assert.throws(
    () => createAdminDemoProviderService({
      repository,
      bybitLifecycleEnabledForTests: true,
    }),
    /requires an injected adapter and transport/,
  );
});

test('credential status and provider listings never return plaintext or ciphertext credentials', async () => {
  const { service } = fixture();
  const listing = await service.listProviders(actor);
  const status = await service.getCredentialStatus(actor, 'OKX');
  const saved = await service.saveCredential(actor, 'OKX', {
    ...secretValues,
    ownerConfirmed: true,
  });
  for (const result of [listing, status, saved]) {
    const serialized = JSON.stringify(result);
    for (const secret of Object.values(secretValues)) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('ciphertext'), false);
  }
  assert.equal(saved.enabled, false);
});

test('owner-confirmed disabled credentials permit only read-only provider operations', async () => {
  const { service, calls, exchangeCalls } = fixture();
  await service.testConnection(actor, 'BYBIT');
  assert.deepEqual(await service.getBalance(actor, 'BYBIT'), balances);
  assert.deepEqual(await service.getInstruments(actor, 'BYBIT'), instruments);
  assert.deepEqual(await service.getPositions(actor, 'BYBIT'), []);
  const preflight = await service.preflight(actor, 'BYBIT', {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '0.01',
  });
  assert.equal(preflight.executionReady, false);
  assert.equal(preflight.result.ready, true);

  const readCredentialCalls = calls.filter((entry) => entry[0] === 'getCredential');
  assert.equal(readCredentialCalls.length, 5);
  assert.ok(exchangeCalls.every((operation) => !operation.includes('Entry') && !operation.includes('order')));
  await assert.rejects(
    service.createSession(actor, 'BYBIT', { symbol: 'BTCUSDT', direction: 'LONG' }),
    /adminLifecycle.*unavailable/,
  );
  await assert.rejects(
    service.createAuthorization(actor, 'BYBIT', '1', 60),
    /adminLifecycle.*unavailable/,
  );
  await assert.rejects(
    service.renewReconciliationAuthorization(actor, 'BYBIT', '1', '2', 60),
    /adminLifecycle.*unavailable/,
  );
  await assert.rejects(
    service.reconcile(actor, 'BYBIT', '1', '2'),
    /reconciliation.*unavailable/,
  );
  assert.equal(calls.some((entry) => entry[0] === 'createSession'), false);
  assert.equal(calls.some((entry) => [
    'createAuthorization',
    'renewReconciliationAuthorization',
    'reserveExecution',
  ].includes(entry[0])), false);
  assert.ok(exchangeCalls.every((operation) => !operation.includes('Entry') && !operation.includes('order')));
});

test('provider-neutral execution contract fails closed before repository or exchange access', async () => {
  const { service, calls, exchangeCalls } = fixture({ credentialsEnabled: true });
  await assert.rejects(
    service.execute(actor, 'BYBIT', {
      sessionId: '501',
      authorizationId: '701',
      idempotencyKey: 'bybit-test-501',
      confirmation: 'PLACE_ADMIN_DEMO_ORDER',
      entryOrderType: 'LIMIT',
      config: {
        symbol: 'BTCUSDT',
        direction: 'LONG',
        quantity: '0.01',
        entryPrice: '1000',
        stopLoss: '900',
        tp1Price: '1100',
        tp2Price: '1200',
        tp3Price: '1300',
        tickSize: '0.1',
      },
    }),
    /Capability adminLifecycle unavailable/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(exchangeCalls, []);
});

test('mock-only Bybit lifecycle persists entry and protection progress in CONFIRM mode', async () => {
  const state = mockLifecycleRepository();
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls);
  const { service, calls, transport } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: state.repositoryOverrides,
  });
  const result = await service.execute(actor, 'BYBIT', {
    sessionId: '501',
    authorizationId: '701',
    idempotencyKey: 'bybit-test-501',
    confirmation: 'PLACE_ADMIN_DEMO_ORDER',
    executionMode: 'CONFIRM',
    entryOrderType: 'LIMIT',
    config: {
      symbol: 'BTCUSDT',
      direction: 'LONG',
      quantity: '0.01',
      entryPrice: '1000',
      stopLoss: '900',
      tp1Price: '1100',
      tp2Price: '1200',
      tp3Price: '1300',
      tickSize: '0.1',
    },
  });
  assert.equal(result.result.status, 'PROTECTED');
  assert.equal(result.execution.executionStatus, 'PROTECTED');
  assert.equal(result.execution.executionMode, 'CONFIRM');
  assert.equal(result.execution.entryExchangeOrderId, 'exchange-entry-1');
  assert.equal(result.execution.stopProtectionId, 'stop-protection-1');
  assert.equal(result.execution.tp3ProtectionId, 'tp3-protection-1');
  assert.equal(result.execution.trailingProtectionId, 'trailing-protection-1');
  assert.ok(state.calls.some((call) =>
    call[0] === 'updateExecutionProgress' && call[4].executionStatus === 'ENTRY_SUBMITTING'));
  assert.deepEqual(state.events.map((event) => event.eventType), [
    'ENTRY_SUBMITTED',
    'PROTECTION_VERIFIED',
  ]);
  const adapterCreation = calls.find((entry) => entry[0] === 'createBybitAdapter');
  assert.equal(adapterCreation[2].executionEnabled, true);
  assert.equal(transport && calls.some((entry) => entry[0] === 'transport'), false);
  assert.ok(exchangeCalls.includes('BYBIT:installProtection'));
});

test('uncertain Bybit entry recovery looks up the original client ID and never resubmits', async () => {
  const state = mockLifecycleRepository();
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls, {
    async submitEntry(scope, request) {
      exchangeCalls.push(['BYBIT:submitEntry', request.clientOrderId]);
      throw new Error('mocked transport timeout');
    },
  });
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: state.repositoryOverrides,
  });
  const input = {
    sessionId: '501',
    authorizationId: '701',
    idempotencyKey: 'bybit-test-501',
    confirmation: 'PLACE_ADMIN_DEMO_ORDER',
    entryOrderType: 'LIMIT',
    config: {
      symbol: 'BTCUSDT',
      direction: 'LONG',
      quantity: '0.01',
      entryPrice: '1000',
      stopLoss: '900',
      tp1Price: '1100',
      tp2Price: '1200',
      tp3Price: '1300',
      tickSize: '0.1',
    },
  };
  const first = await service.execute(actor, 'BYBIT', input);
  const recovered = await service.execute(actor, 'BYBIT', input);
  assert.equal(first.result.status, 'UNCERTAIN');
  assert.equal(recovered.result.status, 'UNCERTAIN');
  assert.equal(state.getExecution().executionStatus, 'ENTRY_UNKNOWN');
  assert.equal(exchangeCalls.filter((call) => Array.isArray(call) && call[0] === 'BYBIT:submitEntry').length, 1);
  assert.equal(exchangeCalls.filter((call) => Array.isArray(call) && call[0] === 'BYBIT:lookupEntry').length, 2);
});

function reconciliationRepositoryOverrides(state) {
  return {
    ...state.repositoryOverrides,
    async getSession(adminUserId, provider, sessionId) {
      return {
        id: sessionId,
        adminUserId,
        provider,
        environment: 'DEMO',
        status: 'RECONCILIATION_REQUIRED',
      };
    },
    async authorizeAction() { return true; },
    async verifyReconciliationLease() { return true; },
    async claimReconciliation() { return true; },
    async releaseReconciliation() { return true; },
  };
}

function recoveryPlan(authorizationId = '702') {
  return {
    sessionId: '501',
    authorizationId,
    entryOrderType: 'LIMIT',
    limitEntryPrice: '1000',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '0.01',
    entryPrice: '1000',
    stopLoss: '900',
    tp1Price: '1100',
    tp2Price: '1200',
    tp3Price: '1300',
    tickSize: '0.1',
    entryClientOrderId: 'entry-client-1',
    stopClientOrderId: 'stop-client-1',
    tp3ClientOrderId: 'tp3-client-1',
    trailingClientOrderId: 'trail-client-1',
  };
}

test('restart recovery finds an accepted timed-out entry by client ID and never resubmits', async () => {
  const state = mockLifecycleRepository();
  const exchangeCalls = [];
  let lookups = 0;
  const adapter = mockLifecycleAdapter(exchangeCalls, {
    async submitEntry(scope, request) {
      exchangeCalls.push(['BYBIT:submitEntry', request.clientOrderId]);
      throw new Error('mocked accepted order response timeout');
    },
    async lookupEntry(scope, symbol, clientOrderId) {
      exchangeCalls.push(['BYBIT:lookupEntry', symbol, clientOrderId]);
      lookups += 1;
      return lookups === 1 ? null : {
        orderId: 'accepted-entry-42',
        status: 'FILLED',
        executedQuantity: '0.01',
      };
    },
  });
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: {
      ...state.repositoryOverrides,
      async renewReconciliationAuthorization(adminUserId, provider, sessionId, oldId) {
        assert.equal(oldId, '702');
        state.getExecution().authorizationId = '703';
        return {
          id: '703',
          sessionId,
          adminUserId,
          provider,
          environment: 'DEMO',
          permittedActions: ['RECONCILE'],
          expiresAt: '2026-01-01T00:10:00.000Z',
          consumedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
        };
      },
      async getSession(adminUserId, provider, sessionId) {
        return {
          id: sessionId,
          adminUserId,
          provider,
          environment: 'DEMO',
          status: 'RECONCILIATION_REQUIRED',
        };
      },
      async authorizeAction() { return true; },
    async verifyReconciliationLease() { return true; },
      async claimReconciliation() { return true; },
      async releaseReconciliation() { return true; },
    },
  });
  const input = {
    sessionId: '501',
    authorizationId: '702',
    idempotencyKey: 'bybit-test-501',
    confirmation: 'PLACE_ADMIN_DEMO_ORDER',
    entryOrderType: 'LIMIT',
    config: {
      symbol: 'BTCUSDT',
      direction: 'LONG',
      quantity: '0.01',
      entryPrice: '1000',
      stopLoss: '900',
      tp1Price: '1100',
      tp2Price: '1200',
      tp3Price: '1300',
      tickSize: '0.1',
    },
  };

  const initial = await service.execute(actor, 'BYBIT', input);
  assert.equal(initial.result.status, 'UNCERTAIN');
  const renewed = await service.renewReconciliationAuthorization(actor, 'BYBIT', '501', '702', 600);
  assert.deepEqual(renewed.permittedActions, ['RECONCILE']);
  const recovered = await service.reconcile(actor, 'BYBIT', '501', '703');

  assert.equal(recovered.result.status, 'PROTECTED');
  assert.equal(recovered.execution.executionStatus, 'PROTECTED');
  assert.equal(recovered.execution.entryExchangeOrderId, 'accepted-entry-42');
  assert.equal(recovered.execution.quantity, '0.01');
  assert.equal(state.getExecution().authorizationId, '703');
  assert.equal(exchangeCalls.filter((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:submitEntry').length, 1);
  assert.equal(exchangeCalls.filter((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:lookupEntry').length, 2);
  assert.ok(exchangeCalls.includes('BYBIT:installProtection'));
  assert.equal(exchangeCalls.some((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:getTicker'), false);
});

test('restart recovery cancels a still-open LIMIT entry and verifies cancellation', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'ENTRY_UNKNOWN' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  const repositoryOverrides = reconciliationRepositoryOverrides(state);
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls, {
    async lookupEntry(scope, symbol, clientOrderId) {
      exchangeCalls.push(['BYBIT:lookupEntry', symbol, clientOrderId]);
      return { orderId: 'open-entry-1', status: 'NEW', executedQuantity: '0' };
    },
    async cancelEntry(scope, symbol, orderId) {
      exchangeCalls.push(['BYBIT:cancelEntry', symbol, orderId]);
      return { orderId, status: 'CANCELED', executedQuantity: '0' };
    },
  });
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides,
  });

  const result = await service.reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result.status, 'FAILED');
  assert.equal(state.getExecution().executionStatus, 'FAILED');
  assert.deepEqual(exchangeCalls.filter((call) => Array.isArray(call)), [
    ['BYBIT:lookupEntry', 'BTCUSDT', 'entry-client-1'],
    ['BYBIT:cancelEntry', 'BTCUSDT', 'open-entry-1'],
  ]);
  assert.equal(exchangeCalls.includes('BYBIT:installProtection'), false);
  assert.equal(exchangeCalls.some((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:submitEntry'), false);
});

test('restart recovery protects only the exact signed partial-fill position quantity', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'ENTRY_UNKNOWN' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls, {
    async lookupEntry(scope, symbol, clientOrderId) {
      exchangeCalls.push(['BYBIT:lookupEntry', symbol, clientOrderId]);
      return { orderId: 'partial-entry-1', status: 'PARTIALLY_FILLED', executedQuantity: '0.004' };
    },
    async cancelEntry(scope, symbol, orderId) {
      exchangeCalls.push(['BYBIT:cancelEntry', symbol, orderId]);
      return { orderId, status: 'CANCELED', executedQuantity: '0.004' };
    },
    async getPosition() {
      exchangeCalls.push('BYBIT:getPosition');
      return { amount: '0.004' };
    },
  });
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: reconciliationRepositoryOverrides(state),
  });

  const result = await service.reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result.status, 'PROTECTED');
  assert.equal(result.execution.quantity, '0.004');
  assert.equal(result.execution.entryExchangeOrderId, 'partial-entry-1');
  assert.equal(result.execution.executionStatus, 'PROTECTED');
  assert.ok(exchangeCalls.includes('BYBIT:installProtection'));
  assert.equal(exchangeCalls.some((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:submitEntry'), false);
});

test('partial-fill position ambiguity persists unknown entry and does not install protection', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'ENTRY_UNKNOWN' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls, {
    async lookupEntry() {
      return { orderId: 'partial-entry-2', status: 'PARTIALLY_FILLED', executedQuantity: '0.004' };
    },
    async cancelEntry(scope, symbol, orderId) {
      return { orderId, status: 'CANCELED', executedQuantity: '0.004' };
    },
    async getPosition() {
      return { amount: '-0.004' };
    },
  });
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: reconciliationRepositoryOverrides(state),
  });

  const result = await service.reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result.status, 'UNCERTAIN');
  assert.equal(result.execution.executionStatus, 'ENTRY_UNKNOWN');
  assert.equal(result.execution.quantity, '0.004');
  assert.equal(result.execution.entryExchangeOrderId, 'partial-entry-2');
  assert.equal(result.execution.protectionStatus, 'PENDING');
  assert.equal(result.execution.stopProtectionId, null);
  assert.equal(exchangeCalls.includes('BYBIT:installProtection'), false);
  assert.equal(exchangeCalls.some((call) =>
    Array.isArray(call) && call[0] === 'BYBIT:submitEntry'), false);
});

test('partial protection IDs require exchange recovery before resuming', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'ENTRY_FILLED' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  state.getExecution().stopProtectionId = 'native-501-sl';
  const exchangeCalls = [];
  let recovered = false;
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: mockLifecycleAdapter(exchangeCalls, {
      async recoverProtection() {
        recovered = true;
        return { stopAlgoId: 'native-501-sl', tp3AlgoId: 'native-501-tp3', trailingAlgoId: 'native-501-trail-tp1' };
      },
    }),
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: reconciliationRepositoryOverrides(state),
  });

  const result = await service.reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result, 'PROTECTED');
  assert.equal(recovered, true);
  assert.equal(state.getExecution().stopProtectionId, 'native-501-sl');
  assert.equal(state.getExecution().protectionStatus, 'PROTECTED');
  assert.equal(exchangeCalls.includes('BYBIT:installProtection'), false);
});

test('ambiguous lookup remains unknown and does not submit or reconcile protections', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'ENTRY_UNKNOWN' });
  const plan = {
    ...recoveryPlan(),
  };
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', plan);
  const repositoryOverrides = reconciliationRepositoryOverrides(state);
  const exchangeCalls = [];
  const adapter = mockLifecycleAdapter(exchangeCalls);
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: adapter,
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides,
  });
  const result = await service.reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result.status, 'UNCERTAIN');
  assert.equal(state.getExecution().executionStatus, 'ENTRY_UNKNOWN');
  assert.deepEqual(exchangeCalls, [['BYBIT:lookupEntry', 'BTCUSDT', 'entry-client-1']]);
});

test('read-only account snapshot returns provider-scoped balance, instruments, positions, and read capabilities', async () => {
  const { service, calls } = fixture();
  const snapshot = await service.getAccountSnapshot(actor, 'GATE');
  assert.equal(snapshot.provider, 'GATE');
  assert.equal(snapshot.environment, 'TESTNET');
  assert.equal(snapshot.connected, true);
  assert.deepEqual(snapshot.balances, balances);
  assert.deepEqual(snapshot.instruments, instruments);
  assert.deepEqual(snapshot.positions, []);
  assert.equal(snapshot.capabilities.entryPreflight, false);
  assert.equal(snapshot.capabilities.adminLifecycle, false);
  const request = calls.find((entry) => entry[0] === 'getCredential');
  assert.deepEqual(request, ['getCredential', actor.id, 'GATE']);
});

test('Binance reads and preflight are fixed to Demo and are explicitly not execution-ready', async () => {
  const { service, calls } = fixture();
  const result = await service.preflight(actor, 'BINANCE', {
    symbol: 'BTCUSDT',
    direction: 'LONG',
    quantity: '0.03',
  });
  assert.equal(result.kind, 'READ_ONLY_PREFLIGHT');
  assert.equal(result.environment, 'DEMO');
  assert.equal(result.executionReady, false);
  assert.equal(result.result.ready, true);
  const exchangeRequests = calls.filter((entry) => entry[0] === 'transport');
  assert.equal(exchangeRequests.length, 3);
  assert.ok(exchangeRequests.every(([, url]) => url.origin === 'https://demo-fapi.binance.com'));
  assert.ok(exchangeRequests.every(([, , init]) => !init.method || init.method === 'GET'));
});

test('Bybit preflight remains a read-only result and preserves the adapter scope check', async () => {
  const { service, exchangeCalls } = fixture();
  const result = await service.preflight(actor, 'BYBIT', {
    symbol: 'BTCUSDT',
    direction: 'SHORT',
    quantity: '0.01',
  });
  assert.equal(result.result.ready, true);
  assert.equal(result.executionReady, false);
  assert.deepEqual(exchangeCalls, ['BYBIT:preflight']);
});

test('BITGET is unsupported and makes zero exchange requests', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.testConnection(actor, 'BITGET'), /unsupported/);
  await assert.rejects(service.getAccountSnapshot(actor, 'BITGET'), /unsupported/);
  assert.equal(calls.some((entry) => ['transport', 'createBybitAdapter', 'createOkxAdapter', 'createGateAdapter'].includes(entry[0])), false);
});

test('authorization, renewal, and reconciliation fail closed without exchange or repository mutations', async () => {
  const { service, calls, exchangeCalls } = fixture({ credentialsEnabled: true });
  await assert.rejects(service.createAuthorization(actor, 'BINANCE', '1', 60), /adminLifecycle.*unavailable/);
  await assert.rejects(service.renewReconciliationAuthorization(actor, 'BYBIT', '1', '2', 60), /adminLifecycle.*unavailable/);
  await assert.rejects(service.reconcile(actor, 'OKX', '1', '2'), /only for BYBIT DEMO/);
  assert.deepEqual(exchangeCalls, []);
  assert.equal(calls.some((entry) => [
    'createAuthorization',
    'renewReconciliationAuthorization',
    'reserveExecution',
  ].includes(entry[0])), false);
});

test('session and history reads remain isolated to the selected admin and provider', async () => {
  const { service, calls } = fixture();
  await service.listSessions(actor, 'OKX', 12);
  await service.listHistory(actor, 'GATE', 13);
  assert.ok(calls.some((entry) => entry[0] === 'listSessions' && entry[1] === actor.id && entry[2] === 'OKX' && entry[3] === 12));
  assert.ok(calls.some((entry) => entry[0] === 'listExecutions' && entry[1] === actor.id && entry[2] === 'GATE' && entry[3] === 13));
  assert.ok(calls.some((entry) => entry[0] === 'listAuditEvents' && entry[1] === actor.id && entry[2] === 'GATE' && entry[3] === 13));
});

test('expired reconciliation authorization blocks exchange reads and mutations', async () => {
  const state = mockLifecycleRepository({ initialStatus: 'PROTECTED' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  const exchangeCalls = [];
  const { service } = fixture({
    credentialsEnabled: true,
    bybitAdapter: mockLifecycleAdapter(exchangeCalls),
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: {
      ...reconciliationRepositoryOverrides(state),
      async authorizeAction() { return false; },
    },
  });
  await assert.rejects(service.reconcile(actor, 'BYBIT', '501', '702'), /authorization/i);
  assert.deepEqual(exchangeCalls, []);
  assert.equal(state.getExecution().executionStatus, 'PROTECTED');
});


async function protectedRecoveryFixture(overrides = {}, repositoryOverrides = {}) {
  const state = mockLifecycleRepository({ initialStatus: 'PROTECTED' });
  await state.repositoryOverrides.reserveExecution(actor.id, 'BYBIT', recoveryPlan());
  Object.assign(state.getExecution(), {
    protectionStatus: 'ACTIVE', stopProtectionId: 'sl-1', tp3ProtectionId: 'tp3-1', trailingProtectionId: 'trail-1',
  });
  const exchangeCalls = [];
  const makeService = () => fixture({
    credentialsEnabled: true,
    bybitAdapter: mockLifecycleAdapter(exchangeCalls, overrides),
    bybitLifecycleEnabledForTests: true,
    repositoryOverrides: { ...reconciliationRepositoryOverrides(state), ...repositoryOverrides },
  }).service;
  return { state, exchangeCalls, makeService };
}

test('TP2 unsupported update persists milestones across service restart and retains protection', async () => {
  const f = await protectedRecoveryFixture({
    async getTicker() { return { lastPrice: '1200', markPrice: '1200' }; },
    async reconcileStagedProtection() {
      return { tp1Reached: true, tp2Reached: true, trailingActivated: false, tp2Update: 'UNSUPPORTED_RETAINED' };
    },
  });
  for (let restart = 0; restart < 2; restart += 1) {
    const result = await f.makeService().reconcile(actor, 'BYBIT', '501', '702');
    assert.equal(result.result, 'UNCERTAIN');
    assert.equal(result.limitation, 'TP2_TRAILING_UPDATE_UNSUPPORTED');
  }
  assert.ok(f.state.getExecution().tp1ReachedAt);
  assert.ok(f.state.getExecution().tp2ReachedAt);
  assert.equal(f.state.getExecution().stopProtectionId, 'sl-1');
  assert.equal(f.state.getExecution().trailingProtectionId, 'trail-1');
  assert.equal(f.state.getExecution().executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(f.exchangeCalls.includes('BYBIT:installProtection'), false);
  assert.equal(f.exchangeCalls.includes('BYBIT:closePositionAndVerify'), false);
  assert.equal(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'), false);
  assert.ok(f.state.events.some((event) => event.eventStatus === 'BLOCKED'));
});

test('TP3 closes the full position and bypasses unsupported TP2 update', async () => {
  let amount = '0.01';
  const f = await protectedRecoveryFixture({
    async getTicker() { return { lastPrice: '1300', markPrice: '1300' }; },
    async reconcileStagedProtection() { throw new Error('TP2 hook must be bypassed at TP3'); },
    async getPosition() { return { amount }; },
    async closePositionAndVerify() { amount = '0'; return { closed: true }; },
  });
  const result = await f.makeService().reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result, 'CLOSED');
  assert.equal(f.state.getExecution().executionStatus, 'CLOSED');
  assert.ok(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'));
});

test('failed zero-position confirmation prevents cleanup and persists reconciliation requirement', async () => {
  const f = await protectedRecoveryFixture({
    async getTicker() { return { lastPrice: '1300', markPrice: '1300' }; },
  });
  const result = await f.makeService().reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result, 'UNCERTAIN');
  assert.equal(f.state.getExecution().executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'), false);
  assert.equal(f.state.getExecution().stopProtectionId, 'sl-1');
});


test('native stop closure below TP3 skips stage verification and confirms cleanup', async () => {
  const f = await protectedRecoveryFixture({
    async getTicker() { return { lastPrice: '950', markPrice: '950' }; },
    async getPosition() { return { amount: '0' }; },
    async reconcileStagedProtection() { throw new Error('stage verification requires open position'); },
  });
  const result = await f.makeService().reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result, 'CLOSED');
  assert.equal(f.state.getExecution().executionStatus, 'CLOSED');
  assert.ok(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'));
});

test('stage verification failure records uncertainty without removing protection', async () => {
  const f = await protectedRecoveryFixture({
    async reconcileStagedProtection() { throw new Error('native trailing readback unavailable'); },
  });
  await assert.rejects(f.makeService().reconcile(actor, 'BYBIT', '501', '702'), /native trailing readback unavailable/);
  assert.equal(f.state.getExecution().executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(f.state.getExecution().stopProtectionId, 'sl-1');
  assert.equal(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'), false);
});



test('known missing protection triggers emergency full close before stage verification', async () => {
  let amount = '0.01';
  const f = await protectedRecoveryFixture({
    async verifyProtection() { return false; },
    async getPosition() { return { amount }; },
    async closePositionAndVerify() { amount = '0'; return { closed: true }; },
    async reconcileStagedProtection() { throw new Error('stage hook must not run without protection'); },
  });
  const result = await f.makeService().reconcile(actor, 'BYBIT', '501', '702');
  assert.equal(result.result, 'CLOSED');
  assert.equal(f.state.getExecution().executionStatus, 'CLOSED');
  assert.ok(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'));
});


test('expired reconciliation lease prevents emergency close and protection removal', async () => {
  const f = await protectedRecoveryFixture({
    async getTicker() { return { lastPrice: '1300', markPrice: '1300' }; },
  }, { async verifyReconciliationLease() { return false; } });
  await assert.rejects(f.makeService().reconcile(actor, 'BYBIT', '501', '702'), /lease|claim|lock/i);
  assert.equal(f.exchangeCalls.includes('BYBIT:closePositionAndVerify'), false);
  assert.equal(f.exchangeCalls.includes('BYBIT:cancelObsoleteProtection'), false);
  assert.equal(f.exchangeCalls.includes('BYBIT:installProtection'), false);
  assert.equal(f.state.getExecution().stopProtectionId, 'sl-1');
});
