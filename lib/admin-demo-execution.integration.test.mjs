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

const { createAdminDemoExecutionService } = require('./admin-demo-execution-service.ts');
const { createPersistentAdminDemoAuthorizationRepository } = require('./admin-demo-authorization.ts');
const { createAdminBinanceDemoExecutionPort } = require('./admin-demo-binance-adapter.ts');

const actor = { id: 9, role: 'admin' };
const config = {
  symbol: 'BTCUSDT',
  direction: 'LONG',
  quantity: '0.1',
  entryPrice: '100',
  stopPrice: '90',
  tp1Price: '110',
  tp2Price: '120',
  tp3Price: '130',
  tickSize: '0.1',
};
const identifiers = { stopAlgoId: '401', tp3AlgoId: '402', trailingAlgoId: '403' };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fixture(options = {}) {
  const session = {
    id: '9001',
    adminUserId: 9,
    testAccountId: '44',
    status: 'CREATED',
    symbol: 'BTCUSDT',
    direction: 'LONG',
    createdAt: new Date().toISOString(),
    authorizationExpiresAt: null,
  };
  const authorization = {
    id: '77',
    adminUserId: 9,
    sessionId: '9001',
    testAccountId: '44',
    exchange: 'BINANCE',
    environment: 'DEMO',
    status: 'ACTIVE',
    permittedActions: ['START_TEST', 'RECONCILE'],
    expiresAt: options.expired ? '2020-01-01T00:00:00.000Z' : new Date(Date.now() + 600_000).toISOString(),
    consumedAt: null,
  };
  let consumed = false;
  let revoked = false;
  const rpcCalls = [];
  const audit = [];
  let record = null;
  let currentMark = '100';
  let positionAmount = '0';
  let nextOrderId = 100;
  let entrySubmissions = 0;
  let failEntryAfterAccept = true;
  let closeOrderSeen = false;
  const openAlgos = new Map();
  const orderByClientId = new Map();
  const requests = [];
  let lock = false;
  const authRepository = createPersistentAdminDemoAuthorizationRepository(
    {
      async rpc(name, parameters) {
        rpcCalls.push({ name, parameters });
        if (name !== 'authorize_admin_demo_test_action') return { data: false, error: null };
        const validScope = parameters.p_admin_user_id === 9 &&
          parameters.p_session_id === session.id &&
          parameters.p_authorization_id === authorization.id;
        if (!validScope || revoked || Date.parse(authorization.expiresAt) <= Date.now()) {
          return { data: false, error: null };
        }
        if (parameters.p_action === 'START_TEST') {
          if (consumed || !authorization.permittedActions.includes('START_TEST')) return { data: false, error: null };
          consumed = true;
          authorization.consumedAt = new Date().toISOString();
          session.status = 'RUNNING';
          return { data: true, error: null };
        }
        return {
          data: parameters.p_action === 'RECONCILE' && consumed &&
            authorization.permittedActions.includes('RECONCILE'),
          error: null,
        };
      },
    },
    {
      async getAuthorization(context) {
        if (context.adminUserId !== 9 || context.sessionId !== session.id ||
            context.testAccountId !== session.testAccountId || context.authorizationId !== authorization.id) return null;
        return authorization;
      },
    },
  );

  function assertScope(scope) {
    assert.equal(scope.kind, 'ADMIN_DEMO_TEST');
    assert.equal(scope.adminUserId, 9);
    assert.equal(scope.sessionId, session.id);
    assert.equal(scope.testAccountId, session.testAccountId);
    assert.equal(scope.environment, 'DEMO');
    assert.equal(scope.executionId, session.id);
    assert.equal(scope.authorizationId, authorization.id);
  }

  const lifecycleDeps = {
    authorization: { async assertAuthorized() {} },
    environment: { async assertEnvironment() {} },
    exchange: {
      async installProtection() { throw new Error('injected Admin Demo adapter must be used'); },
      async verifyProtection() { return false; },
      async getPosition() { return { amount: positionAmount }; },
      async closePositionAndVerify() { return { closed: false }; },
      async cancelObsoleteProtection() {},
    },
    executions: {
      async assertScope(scope) { assertScope(scope); if (!record) throw new Error('no execution'); },
      async markProtected(scope, ids) { assertScope(scope); Object.assign(record, {
        execution_status: 'PROTECTED', protection_status: 'PROTECTED',
        stop_algo_order_id: ids.stopAlgoId, tp3_algo_order_id: ids.tp3AlgoId,
        trailing_algo_order_id: ids.trailingAlgoId,
      }); },
      async markClosed(scope) { assertScope(scope); record.execution_status = 'CLOSED'; session.status = 'PASSED'; },
      async markUncertain(scope) { assertScope(scope); record.execution_status = 'RECONCILIATION_REQUIRED'; session.status = 'RECONCILIATION_REQUIRED'; },
    },
    entries: {
      async reserveEntry(scope, request) {
        assertScope(scope);
        if (!record) {
          record = {
            session_id: session.id,
            admin_user_id: actor.id,
            authorization_id: authorization.id,
            test_account_id: session.testAccountId,
            symbol: request.execution.symbol,
            direction: request.execution.direction,
            quantity: request.execution.quantity,
            entry_client_order_id: request.clientOrderId,
            entry_exchange_order_id: null,
            execution_status: 'ENTRY_SUBMITTING',
            stop_algo_order_id: null,
            tp3_algo_order_id: null,
            trailing_algo_order_id: null,
            stop_client_algo_id: 'stop-client-1',
            tp3_client_algo_id: 'tp3-client-1',
            trailing_client_algo_id: 'trail-client-1',
            entry_price: request.entryPrice,
            stop_loss: request.execution.stopPrice,
            tp1_price: request.execution.tp1Price,
            tp2_price: request.execution.tp2Price,
            tp3_price: request.execution.tp3Price,
            tick_size: request.execution.tickSize,
            leverage: 1,
            tp1_reached_at: null,
            tp2_reached_at: null,
            protection_status: 'PENDING',
          };
          return 'CREATED';
        }
        if (record.entry_client_order_id === request.clientOrderId) return 'EXISTING';
        return 'BUSY';
      },
      async markEntryUncertain(scope) { assertScope(scope); record.execution_status = 'ENTRY_UNKNOWN'; },
      async markEntryFailed(scope) { assertScope(scope); record.execution_status = 'FAILED'; },
      async markEntryFilled(scope, order, quantity) {
        assertScope(scope);
        record.execution_status = 'ENTRY_FILLED';
        record.entry_exchange_order_id = order.orderId;
        record.quantity = quantity;
      },
    },
    protections: {
      async loadProtectionIdentifiers(scope) {
        assertScope(scope);
        if (!record?.stop_algo_order_id) return null;
        return {
          stopAlgoId: record.stop_algo_order_id,
          tp3AlgoId: record.tp3_algo_order_id,
          trailingAlgoId: record.trailing_algo_order_id,
        };
      },
      async markProtectionVerified(scope, ids, progress) {
        assertScope(scope);
        Object.assign(record, {
          stop_algo_order_id: ids.stopAlgoId,
          tp3_algo_order_id: ids.tp3AlgoId,
          trailing_algo_order_id: ids.trailingAlgoId,
          tp1_reached_at: progress.tp1Reached ? record.tp1_reached_at ?? new Date().toISOString() : record.tp1_reached_at,
          tp2_reached_at: progress.tp2Reached ? record.tp2_reached_at ?? new Date().toISOString() : record.tp2_reached_at,
          protection_status: progress.trailingActivated ? 'TRAILING' : 'PROTECTED',
        });
      },
      async markProtectionFailed(scope) { assertScope(scope); record.protection_status = 'FAILED'; },
    },
    reconciliation: {
      async claim(scope) { assertScope(scope); if (lock) return false; lock = true; return true; },
      async release(scope) { assertScope(scope); lock = false; },
    },
    events: {
      async publish(event) { assertScope(event.scope); audit.push({ type: event.type, status: 'SUCCEEDED' }); },
    },
  };

  const repository = {
    lifecycle: {},
    getSession: async (adminUserId, sessionId) =>
      adminUserId === session.adminUserId && sessionId === session.id ? { ...session } : null,
    createSession: async (adminUserId, symbol, direction) => {
      assert.equal(adminUserId, actor.id);
      Object.assign(session, { symbol, direction });
      return { ...session };
    },
    createAuthorization: async (adminUserId, sessionId) => {
      assert.equal(adminUserId, actor.id);
      assert.equal(sessionId, session.id);
      session.status = 'AUTHORIZED';
      return { id: authorization.id, testAccountId: session.testAccountId, expiresAt: authorization.expiresAt };
    },
    renewReconciliationAuthorization: async (adminUserId, sessionId, authorizationId, expiresInSeconds) => {
      assert.equal(adminUserId, actor.id);
      assert.equal(sessionId, session.id);
      assert.equal(authorizationId, authorization.id);
      assert.ok(expiresInSeconds >= 30 && expiresInSeconds <= 900);
      assert.ok(Date.parse(authorization.expiresAt) <= Date.now());
      assert.ok(record);
      assert.equal(record.authorization_id, authorizationId);
      assert.ok(['ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED', 'RECONCILIATION_REQUIRED'].includes(record.execution_status));
      authorization.id = '78';
      authorization.permittedActions = ['RECONCILE'];
      authorization.expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      authorization.consumedAt = new Date().toISOString();
      record.authorization_id = authorization.id;
      session.authorizationExpiresAt = authorization.expiresAt;
      audit.push({ type: 'AUTHORIZATION_RENEWED', status: 'SUCCEEDED' });
      return { id: authorization.id, testAccountId: session.testAccountId, expiresAt: authorization.expiresAt };
    },
    revokeAuthorization: async () => { revoked = true; return true; },
    getSessionHistory: async (adminUserId, sessionId) =>
      adminUserId === actor.id && sessionId === session.id ? audit.slice() : [],
    getExecution: async (scope) => {
      assertScope(scope);
      return record ? { ...record } : null;
    },
    appendAudit: async (scope, type, status, details) => {
      assertScope(scope);
      audit.push({ type, status, details });
    },
    executions: lifecycleDeps.executions,
    entries: lifecycleDeps.entries,
    protections: lifecycleDeps.protections,
    reconciliation: lifecycleDeps.reconciliation,
    events: lifecycleDeps.events,
  };
  repository.lifecycle = {
    authorization: { async assertAuthorized() {} },
    environment: { async assertEnvironment() {} },
    exchange: {},
    executions: repository.executions,
    entries: repository.entries,
    protections: repository.protections,
    reconciliation: repository.reconciliation,
    events: repository.events,
  };

  const transport = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), method: init.method ?? 'GET', apiKey: init.headers?.['X-MBX-APIKEY'] });
    assert.equal(url.origin, 'https://demo-fapi.binance.com', 'all signed and public requests must use fixed Demo host');
    if (init.headers?.['X-MBX-APIKEY'] !== undefined) {
      assert.equal(init.headers['X-MBX-APIKEY'], 'dedicated-demo-key');
    }
    const params = url.searchParams;
    const method = init.method ?? 'GET';
    const pathName = url.pathname;
    if (pathName.endsWith('/fapi/v3/account')) return response({ canTrade: true });
    if (pathName.endsWith('/fapi/v1/positionSide/dual')) return response({ dualSidePosition: false });
    if (pathName.endsWith('/fapi/v1/exchangeInfo')) return response({
      symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
          { filterType: 'MIN_NOTIONAL', notional: '5' },
        ],
      }],
    });
    if (pathName.endsWith('/fapi/v1/premiumIndex')) return response({ markPrice: currentMark });
    if (pathName.endsWith('/fapi/v3/positionRisk')) return response([{ symbol: 'BTCUSDT', positionAmt: positionAmount }]);
    if (pathName.endsWith('/fapi/v1/order') && method === 'POST' && params.get('type') === 'MARKET') {
      const clientId = params.get('newClientOrderId');
      if (params.get('reduceOnly') === 'true') {
        positionAmount = '0';
        closeOrderSeen = true;
        return response({ orderId: String(++nextOrderId), status: 'FILLED', executedQty: config.quantity });
      }
      entrySubmissions += 1;
      const signedQty = params.get('side') === 'BUY' ? config.quantity : `-${config.quantity}`;
      positionAmount = signedQty;
      const order = { orderId: String(++nextOrderId), status: 'FILLED', executedQty: config.quantity };
      orderByClientId.set(clientId, order);
      if (failEntryAfterAccept) {
        failEntryAfterAccept = false;
        throw new TypeError('simulated timeout after exchange accepted entry');
      }
      return response(order);
    }
    if (pathName.endsWith('/fapi/v1/order') && method === 'GET') {
      if (params.has('origClientOrderId')) {
        const order = orderByClientId.get(params.get('origClientOrderId'));
        return order ? response(order) : response({ code: -2013, msg: 'Order does not exist.' }, 400);
      }
      if (params.has('origClientOrderId') && closeOrderSeen) return response({ status: 'FILLED' });
      return response({ code: -2013, msg: 'Order does not exist.' }, 400);
    }
    if (pathName.endsWith('/fapi/v1/algoOrder') && method === 'POST') {
      const order = {
        algoId: ++nextOrderId,
        clientAlgoId: params.get('clientAlgoId'),
        algoStatus: 'NEW',
        algoType: 'CONDITIONAL',
        symbol: params.get('symbol'),
        side: params.get('side'),
        positionSide: params.get('positionSide'),
        orderType: params.get('type'),
        ...(params.has('triggerPrice') ? {
          triggerPrice: params.get('triggerPrice'),
          closePosition: params.get('closePosition'),
          workingType: params.get('workingType'),
        } : {
          activatePrice: params.get('activatePrice'),
          callbackRate: params.get('callbackRate'),
          quantity: params.get('quantity'),
          reduceOnly: params.get('reduceOnly'),
          workingType: params.get('workingType'),
        }),
      };
      openAlgos.set(String(order.algoId), order);
      return response(order);
    }
    if (pathName.endsWith('/fapi/v1/openAlgoOrders') && method === 'GET') {
      return response([...openAlgos.values()]);
    }
    if (pathName.endsWith('/fapi/v1/algoOrder') && method === 'GET') {
      const order = params.has('algoId')
        ? openAlgos.get(params.get('algoId'))
        : [...openAlgos.values()].find((item) => item.clientAlgoId === params.get('clientAlgoId'));
      return order ? response(order) : response({ code: -2013, msg: 'Order does not exist.' }, 400);
    }
    if (pathName.endsWith('/fapi/v1/algoOrder') && method === 'DELETE') {
      openAlgos.delete(params.get('algoId'));
      return response({ code: 200 });
    }
    return response({ code: -1000, msg: 'Unexpected fake route.' }, 400);
  };

  const service = createAdminDemoExecutionService({
    repository,
    authorization: authRepository,
    async loadCredentials(adminUserId, testAccountId) {
      assert.equal(adminUserId, actor.id);
      assert.equal(testAccountId, session.testAccountId);
      return {
        testAccountId,
        environment: options.liveCredential ? 'LIVE' : 'DEMO',
        apiKey: 'dedicated-demo-key',
        apiSecret: 'fake-secret',
      };
    },
    createExchange: (credentials, records, injectedTransport) =>
      createAdminBinanceDemoExecutionPort(credentials, records, injectedTransport),
    transport,
    async assertExecutionEnabled(_actor, confirmation) {
      assert.equal(confirmation, 'RUN_BINANCE_DEMO_LIFECYCLE');
      if (options.blockExecution) throw new Error('execution gate blocked');
    },
  });

  return {
    actor, config, session, authorization, service, repository, transport,
    openAlgos, requests, audit, rpcCalls,
    get entrySubmissions() { return entrySubmissions; },
    get positionAmount() { return positionAmount; },
    set currentMark(value) { currentMark = value; },
    get record() { return record; },
    get consumed() { return consumed; },
    async setup() {
      const created = await service.createSession(actor, { symbol: config.symbol, direction: config.direction });
      const auth = await service.createAuthorization(actor, created.id);
      return { sessionId: created.id, authorizationId: auth.id };
    },
  };
}

test('Admin Demo service runs entry timeout recovery, protection, TP1/TP2 continuation, TP3 close and cleanup offline', async () => {
  const f = fixture();
  const { sessionId, authorizationId } = await f.setup();
  const preflight = await f.service.preflight(
    f.actor, sessionId, authorizationId, f.config, 'RUN_BINANCE_DEMO_LIFECYCLE',
  );
  assert.equal(preflight.ready, true);
  assert.equal(f.consumed, false, 'read-only preflight must not consume the one-time authorization');

  const submitted = await f.service.execute(f.actor, {
    sessionId,
    authorizationId,
    idempotencyKey: 'admin-entry-9001',
    config: f.config,
    confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  });
  assert.equal(submitted.result.status, 'PROTECTED', JSON.stringify(submitted.result));
  assert.equal(f.entrySubmissions, 1, 'timeout recovery looked up the accepted order instead of duplicating entry');
  assert.equal(f.positionAmount, '0.1');
  assert.equal(f.openAlgos.size, 3, 'initial SL, TP3, and dormant TP1 trailing were installed');
  assert.equal(f.record.execution_status, 'PROTECTED');
  assert.ok(f.rpcCalls.some((call) => call.parameters.p_action === 'START_TEST'));
  assert.ok(f.rpcCalls.some((call) => call.parameters.p_action === 'RECONCILE'));
  assert.ok(f.requests.every((request) => new URL(request.url).origin === 'https://demo-fapi.binance.com'));

  f.currentMark = '110';
  const tp1 = await f.service.reconcile(f.actor, sessionId, authorizationId, 'RUN_BINANCE_DEMO_LIFECYCLE');
  assert.equal(tp1.result, 'PROTECTED');
  assert.ok(f.record.tp1_reached_at);
  assert.equal(f.positionAmount, '0.1', 'TP1 must not close any quantity');
  assert.equal(f.openAlgos.size, 3);

  f.currentMark = '120';
  const tp2 = await f.service.reconcile(f.actor, sessionId, authorizationId, 'RUN_BINANCE_DEMO_LIFECYCLE');
  assert.equal(tp2.result, 'PROTECTED');
  assert.ok(f.record.tp2_reached_at);
  assert.equal(f.positionAmount, '0.1', 'TP2 must not close any quantity');
  assert.equal(f.openAlgos.size, 3);

  f.currentMark = '130';
  const tp3 = await f.service.reconcile(f.actor, sessionId, authorizationId, 'RUN_BINANCE_DEMO_LIFECYCLE');
  assert.equal(tp3.result, 'CLOSED');
  assert.equal(f.positionAmount, '0');
  assert.equal(f.openAlgos.size, 0);
  assert.equal(f.record.execution_status, 'CLOSED');
  assert.equal(f.session.status, 'PASSED');
  assert.ok(f.audit.some((event) => event.type === 'EXECUTION_CLOSED'));
  assert.ok(f.requests.findIndex((request) => request.url.includes('reduceOnly=true')) >= 0);
});

test('Admin service rejects non-admin, wrong session, expired authorization, replay, and Live credentials', async () => {
  const f = fixture();
  const { sessionId, authorizationId } = await f.setup();
  await assert.rejects(f.service.createSession({ id: 8, role: 'user' }, { symbol: 'BTCUSDT', direction: 'LONG' }));
  await assert.rejects(f.service.execute(f.actor, {
    sessionId: '9002', authorizationId, idempotencyKey: 'entry-wrong-session',
    config: f.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  }));
  f.authorization.expiresAt = '2020-01-01T00:00:00.000Z';
  await assert.rejects(f.service.execute(f.actor, {
    sessionId, authorizationId, idempotencyKey: 'entry-expired',
    config: f.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  }));

  const live = fixture({ liveCredential: true });
  const liveIds = await live.setup();
  await assert.rejects(live.service.execute(live.actor, {
    ...liveIds, idempotencyKey: 'entry-live',
    config: live.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  }), /Dedicated Binance Demo credentials/);
  assert.equal(live.requests.length, 0, 'LIVE-marked credentials are rejected before transport use');

  const replay = fixture();
  const replayIds = await replay.setup();
  await replay.service.execute(replay.actor, {
    ...replayIds, idempotencyKey: 'entry-replay',
    config: replay.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  });
  await assert.rejects(replay.service.execute(replay.actor, {
    ...replayIds, idempotencyKey: 'entry-replay',
    config: replay.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  }));
  assert.equal(replay.entrySubmissions, 1);
});

test('expired Admin Demo authorization can be renewed for bounded reconciliation without another entry', async () => {
  const f = fixture();
  const { sessionId, authorizationId } = await f.setup();
  const executed = await f.service.execute(f.actor, {
    sessionId,
    authorizationId,
    idempotencyKey: 'entry-reconcile-renew',
    config: f.config,
    confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  });
  assert.equal(executed.result.status, 'PROTECTED');

  f.authorization.expiresAt = '2020-01-01T00:00:00.000Z';
  const renewed = await f.service.renewReconciliationAuthorization(f.actor, sessionId, authorizationId);
  assert.notEqual(renewed.id, authorizationId);
  assert.deepEqual(f.authorization.permittedActions, ['RECONCILE']);
  assert.equal(f.record.authorization_id, renewed.id);

  const reconciled = await f.service.reconcile(
    f.actor, sessionId, renewed.id, 'RUN_BINANCE_DEMO_LIFECYCLE',
  );
  assert.equal(reconciled.result, 'PROTECTED');
  assert.equal(f.entrySubmissions, 1, 'reconciliation renewal must not submit another entry');
  assert.ok(f.audit.some((event) => event.type === 'AUTHORIZATION_RENEWED'));
  assert.ok(f.rpcCalls.some((call) => call.parameters.p_action === 'RECONCILE'));
});

test('Admin Demo repository scope, lock conflicts, and flat-before-cleanup behavior fail closed', async () => {
  const f = fixture();
  const { sessionId, authorizationId } = await f.setup();
  const executed = await f.service.execute(f.actor, {
    sessionId, authorizationId, idempotencyKey: 'entry-lock-test',
    config: f.config, confirmation: 'RUN_BINANCE_DEMO_LIFECYCLE',
  });
  assert.equal(executed.result.status, 'PROTECTED');

  const scope = {
    kind: 'ADMIN_DEMO_TEST', adminUserId: 9, testAccountId: '44',
    sessionId, executionId: sessionId, authorizationId,
    strategy: 'STANDARD', environment: 'DEMO',
  };
  await assert.rejects(f.repository.getExecution({ ...scope, adminUserId: 10 }));
  const repo = f.repository.lifecycle.reconciliation;
  assert.equal(await repo.claim(scope), true);
  assert.equal(await repo.claim(scope), false, 'a concurrent reconciliation cannot claim the active lock');
  await repo.release(scope);

  const exchange = createAdminBinanceDemoExecutionPort(
    { testAccountId: '44', environment: 'DEMO', apiKey: 'dedicated-demo-key', apiSecret: 'fake-secret' },
    f.repository,
    f.transport,
  );
  await assert.rejects(exchange.cancelObsoleteProtection(scope, f.config, identifiers), /flat position/);
  assert.equal(f.openAlgos.size, 3, 'protection remains installed until the position is confirmed zero');
});
