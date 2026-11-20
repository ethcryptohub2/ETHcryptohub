import 'server-only';

import { z } from 'zod';
import { requirePersistentAdminDemoAuthorization, type AdminDemoAuthorizationRepository } from './admin-demo-authorization';
import { createServerAdminDemoAuthorizationRepository } from './admin-demo-supabase';
import {
  createAdminDemoExecutionRepository,
  type AdminDemoExecutionRecord,
  type AdminDemoQuery,
} from './admin-demo-execution-repository';
import { loadAdminDemoCredentials } from './admin-demo-credentials';
import {
  createAdminBinanceDemoExecutionPort,
  type BinanceDemoTransport,
} from './admin-demo-binance-adapter';
import {
  createAdminDemoExecutionLifecycle,
  type ExecutionLifecycleDependencies,
  type ExecutionScope,
  type LifecycleExecution,
} from './execution-lifecycle';
import { isAdminDemoExecutionRequestApproved } from './admin-demo-staging-policy';
import type { User } from './auth';
import { query } from './db';

const demoConfigSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  direction: z.enum(['LONG', 'SHORT']),
  quantity: z.string().regex(/^\d+(?:\.\d+)?$/),
  entryPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
  stopPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
  tp1Price: z.string().regex(/^\d+(?:\.\d+)?$/),
  tp2Price: z.string().regex(/^\d+(?:\.\d+)?$/),
  tp3Price: z.string().regex(/^\d+(?:\.\d+)?$/),
  tickSize: z.string().regex(/^\d+(?:\.\d+)?$/),
}).strict();

export type AdminDemoTradeConfig = z.infer<typeof demoConfigSchema>;
export type AdminDemoActor = Pick<User, 'id' | 'role'>;

export interface AdminDemoServiceRepository {
  getSession(adminUserId: number, sessionId: string): Promise<{
    id: string;
    adminUserId: number;
    testAccountId: string;
    status: string;
    symbol: string | null;
    direction: 'LONG' | 'SHORT' | null;
    createdAt: string;
    authorizationExpiresAt: string | null;
  } | null>;
  createSession(adminUserId: number, symbol: string, direction: 'LONG' | 'SHORT'): Promise<{
    id: string;
    adminUserId: number;
    testAccountId: string;
    status: string;
    symbol: string | null;
    direction: 'LONG' | 'SHORT' | null;
    createdAt: string;
    authorizationExpiresAt: string | null;
  }>;
  createAuthorization(adminUserId: number, sessionId: string, expiresInSeconds: number): Promise<{
    id: string;
    testAccountId: string;
    expiresAt: string;
  }>;
  renewReconciliationAuthorization(
    adminUserId: number,
    sessionId: string,
    authorizationId: string,
    expiresInSeconds: number,
  ): Promise<{ id: string; testAccountId: string; expiresAt: string }>;
  revokeAuthorization(adminUserId: number, sessionId: string, authorizationId: string): Promise<boolean>;
  getSessionHistory(adminUserId: number, sessionId: string): Promise<unknown[]>;
  getExecution(scope: ExecutionScope): Promise<AdminDemoExecutionRecord | null>;
  appendAudit(
    scope: ExecutionScope,
    eventType: string,
    status: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'BLOCKED',
    details: Record<string, string | number | boolean | null>,
  ): Promise<void>;
  lifecycle: ExecutionLifecycleDependencies;
}

export type AdminDemoServiceDependencies = {
  repository: AdminDemoServiceRepository;
  authorization: AdminDemoAuthorizationRepository;
  loadCredentials(adminUserId: number, testAccountId: string): Promise<{
    testAccountId: string;
    apiKey: string;
    apiSecret: string;
    environment: 'DEMO';
  }>;
  createExchange: typeof createAdminBinanceDemoExecutionPort;
  transport?: BinanceDemoTransport;
  assertExecutionEnabled(actor: AdminDemoActor, confirmation: string): Promise<void>;
};

function assertAdmin(actor: AdminDemoActor): asserts actor is AdminDemoActor & { role: 'admin' } {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.role !== 'admin') {
    throw new Error('Administrator access is required.');
  }
}

function lifecycleExecution(config: AdminDemoTradeConfig, closeClientOrderId?: string): LifecycleExecution {
  return {
    symbol: config.symbol,
    direction: config.direction,
    quantity: config.quantity,
    stopPrice: config.stopPrice,
    tp1Price: config.tp1Price,
    tp2Price: config.tp2Price,
    tp3Price: config.tp3Price,
    tickSize: config.tickSize,
    ...(closeClientOrderId ? { closeClientOrderId } : {}),
  };
}

function scopeFromSession(
  actor: AdminDemoActor,
  session: { id: string; testAccountId: string },
  authorizationId: string,
): Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }> {
  return {
    kind: 'ADMIN_DEMO_TEST',
    adminUserId: actor.id,
    testAccountId: session.testAccountId,
    sessionId: session.id,
    executionId: session.id,
    authorizationId,
    strategy: 'STANDARD',
    environment: 'DEMO',
  };
}

function validatePrices(config: AdminDemoTradeConfig) {
  const values = [
    config.quantity, config.entryPrice, config.stopPrice, config.tp1Price,
    config.tp2Price, config.tp3Price, config.tickSize,
  ].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Admin Demo trade configuration must use positive finite values.');
  }
  const [, entry, stop, tp1, tp2, tp3] = values;
  const ordered = config.direction === 'LONG'
    ? stop! < entry! && entry! < tp1! && tp1! < tp2! && tp2! < tp3!
    : tp3! < tp2! && tp2! < tp1! && tp1! < entry! && entry! < stop!;
  if (!ordered) throw new Error('Admin Demo protection prices do not match the selected direction.');
}

export function createAdminDemoExecutionService(dependencies: AdminDemoServiceDependencies) {
  async function getOwnedSession(actor: AdminDemoActor, sessionId: string) {
    assertAdmin(actor);
    if (!/^[1-9]\d*$/.test(sessionId)) throw new Error('Admin Demo session identifier is invalid.');
    const session = await dependencies.repository.getSession(actor.id, sessionId);
    if (!session || session.adminUserId !== actor.id || session.status === 'REVOKED' ||
        session.status === 'EXPIRED') {
      throw new Error('Admin Demo session is unavailable or not owned by this administrator.');
    }
    return session;
  }

  async function assertAuthorization(
    actor: AdminDemoActor,
    session: { id: string; testAccountId: string },
    authorizationId: string,
    action: 'START_TEST' | 'RECONCILE',
  ) {
    return requirePersistentAdminDemoAuthorization(dependencies.authorization, {
      adminUserId: actor.id,
      sessionId: session.id,
      testAccountId: session.testAccountId,
      authorizationId,
      exchange: 'BINANCE',
      environment: 'DEMO',
      action,
    });
  }

  async function createLifecycle(
    actor: AdminDemoActor & { role: 'admin' },
    session: { id: string; testAccountId: string },
    authorizationId: string,
  ) {
    const scope = scopeFromSession(actor, session, authorizationId);
    const credentials = await dependencies.loadCredentials(actor.id, session.testAccountId);
    if (credentials.environment !== 'DEMO' || credentials.testAccountId !== session.testAccountId) {
      throw new Error('Dedicated Binance Demo credentials do not match the authorized test account.');
    }
    const exchange = dependencies.createExchange(credentials, dependencies.repository, dependencies.transport);
    if (exchange.environment !== 'DEMO' || exchange.baseUrl !== 'https://demo-fapi.binance.com') {
      throw new Error('Only the fixed Binance Demo endpoint is permitted for Admin tests.');
    }
    const lifecycleDependencies: ExecutionLifecycleDependencies = {
      ...dependencies.repository.lifecycle,
      exchange,
      authorization: {
        async assertAuthorized(candidate) {
          if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.sessionId !== session.id ||
              candidate.adminUserId !== actor.id || candidate.testAccountId !== session.testAccountId ||
              candidate.authorizationId !== authorizationId) {
            throw new Error('Admin Demo authorization scope changed.');
          }
          await assertAuthorization(actor, session, authorizationId, 'RECONCILE');
        },
      },
      environment: {
        async assertEnvironment(candidate) {
          if (candidate.kind !== 'ADMIN_DEMO_TEST' || candidate.environment !== 'DEMO' ||
              exchange.environment !== 'DEMO' || exchange.baseUrl !== 'https://demo-fapi.binance.com') {
            throw new Error('Admin Demo exchange environment is not fixed to Binance Demo.');
          }
        },
      },
      executions: dependencies.repository.lifecycle.executions,
      entries: dependencies.repository.lifecycle.entries,
      protections: dependencies.repository.lifecycle.protections,
      reconciliation: dependencies.repository.lifecycle.reconciliation,
      events: dependencies.repository.lifecycle.events,
    };
    const lifecycle = createAdminDemoExecutionLifecycle(lifecycleDependencies, {
      async assertAdminRole(candidate) {
        assertAdmin(actor);
        if (candidate.adminUserId !== actor.id) throw new Error('Administrator identity changed.');
      },
      async assertTemporaryAuthorization(candidate) {
        await assertAuthorization(actor, session, candidate.authorizationId, 'RECONCILE');
      },
      async assertIsolatedDemoAccount(candidate) {
        if (
          candidate.sessionId !== session.id ||
          candidate.testAccountId !== session.testAccountId ||
          credentials.testAccountId !== session.testAccountId ||
          credentials.environment !== 'DEMO'
        ) throw new Error('Admin Demo account scope is not isolated.');
        const fresh = await getOwnedSession(actor, session.id);
        if (fresh.testAccountId !== session.testAccountId) throw new Error('Admin Demo session account changed.');
      },
    });
    return { lifecycle, exchange, scope };
  }

  return {
    async createSession(actor: AdminDemoActor, input: { symbol: string; direction: 'LONG' | 'SHORT' }) {
      assertAdmin(actor);
      if (!/^[A-Z0-9]{2,30}$/.test(input.symbol) ||
          !['LONG', 'SHORT'].includes(input.direction)) throw new Error('Admin Demo session input is invalid.');
      return dependencies.repository.createSession(actor.id, input.symbol, input.direction);
    },
    async createAuthorization(actor: AdminDemoActor, sessionId: string, expiresInSeconds = 600) {
      const session = await getOwnedSession(actor, sessionId);
      if (session.status !== 'CREATED') throw new Error('Authorization can only be created for a new Admin Demo session.');
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 900) {
        throw new Error('Admin Demo authorization expiry must be between 30 and 900 seconds.');
      }
      return dependencies.repository.createAuthorization(actor.id, session.id, expiresInSeconds);
    },
    async renewReconciliationAuthorization(
      actor: AdminDemoActor,
      sessionId: string,
      authorizationId: string,
      expiresInSeconds = 600,
    ) {
      const session = await getOwnedSession(actor, sessionId);
      if (!['RUNNING', 'RECONCILIATION_REQUIRED'].includes(session.status)) {
        throw new Error('A reconciliation-only authorization can only be renewed for an active Demo session.');
      }
      if (!/^[1-9]\d*$/.test(authorizationId)) {
        throw new Error('Admin Demo authorization identifier is invalid.');
      }
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 900) {
        throw new Error('Admin Demo recovery authorization expiry must be between 30 and 900 seconds.');
      }
      const scope = scopeFromSession(actor as AdminDemoActor & { role: 'admin' }, session, authorizationId);
      const execution = await dependencies.repository.getExecution(scope);
      if (
        !execution ||
        execution.authorization_id !== authorizationId ||
        !['ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED', 'RECONCILIATION_REQUIRED']
          .includes(execution.execution_status)
      ) {
        throw new Error('Only the expired authorization for a recoverable Demo execution can be renewed.');
      }
      return dependencies.repository.renewReconciliationAuthorization(
        actor.id,
        session.id,
        authorizationId,
        expiresInSeconds,
      );
    },
    async revokeAuthorization(actor: AdminDemoActor, sessionId: string, authorizationId: string) {
      const session = await getOwnedSession(actor, sessionId);
      if (!/^[1-9]\d*$/.test(authorizationId)) throw new Error('Admin Demo authorization identifier is invalid.');
      return dependencies.repository.revokeAuthorization(actor.id, session.id, authorizationId);
    },
    async preflight(
      actor: AdminDemoActor,
      sessionId: string,
      authorizationId: string,
      rawConfig: unknown,
      confirmation: string,
    ) {
      assertAdmin(actor);
      await dependencies.assertExecutionEnabled(actor, confirmation);
      const session = await getOwnedSession(actor, sessionId);
      if (session.symbol === null || session.direction === null) throw new Error('Admin Demo session is incomplete.');
      const parsed = demoConfigSchema.safeParse(rawConfig);
      if (!parsed.success) throw new Error('Admin Demo test configuration is invalid.');
      validatePrices(parsed.data);
      if (parsed.data.symbol !== session.symbol || parsed.data.direction !== session.direction) {
        throw new Error('Test configuration does not match the Admin Demo session.');
      }
      const { exchange, scope } = await createLifecycle(actor as AdminDemoActor & { role: 'admin' }, session, authorizationId);
      const preflight = await exchange.preflight(scope, lifecycleExecution(parsed.data));
      return {
        ...preflight,
        environment: 'DEMO' as const,
        customerExecutionEnabled: false,
        targetVerified: true,
      };
    },
    async execute(
      actor: AdminDemoActor,
      input: {
        sessionId: string;
        authorizationId: string;
        idempotencyKey: string;
        config: unknown;
        confirmation: string;
      },
    ) {
      assertAdmin(actor);
      await dependencies.assertExecutionEnabled(actor, input.confirmation);
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(input.idempotencyKey)) {
        throw new Error('Admin Demo idempotency key is invalid.');
      }
      const session = await getOwnedSession(actor, input.sessionId);
      if (session.symbol === null || session.direction === null) throw new Error('Admin Demo session is incomplete.');
      const parsed = demoConfigSchema.safeParse(input.config);
      if (!parsed.success) throw new Error('Admin Demo test configuration is invalid.');
      validatePrices(parsed.data);
      if (parsed.data.symbol !== session.symbol || parsed.data.direction !== session.direction) {
        throw new Error('Test configuration does not match the Admin Demo session.');
      }
      const requestedScope = scopeFromSession(actor as AdminDemoActor & { role: 'admin' }, session, input.authorizationId);
      const existing = await dependencies.repository.getExecution(requestedScope);
      const recovery = Boolean(
        existing &&
        existing.entry_client_order_id === input.idempotencyKey &&
        existing.authorization_id === input.authorizationId &&
        ['ENTRY_UNKNOWN', 'ENTRY_SUBMITTING', 'ENTRY_FILLED', 'RECONCILIATION_REQUIRED'].includes(existing.execution_status),
      );
      await assertAuthorization(actor, session, input.authorizationId, recovery ? 'RECONCILE' : 'START_TEST');
      const { lifecycle, scope } = await createLifecycle(actor as AdminDemoActor & { role: 'admin' }, session, input.authorizationId);
      await dependencies.repository.appendAudit(scope, 'TEST_STARTED', 'SUCCEEDED', {
        symbol: parsed.data.symbol,
        direction: parsed.data.direction,
        environment: 'DEMO',
      });
      const result = await lifecycle.submitAndProtectEntry(scope, {
        clientOrderId: input.idempotencyKey,
        entryPrice: parsed.data.entryPrice,
        execution: lifecycleExecution(parsed.data),
      });
      return { result, sessionId: session.id, environment: 'DEMO' as const };
    },
    async reconcile(
      actor: AdminDemoActor,
      sessionId: string,
      authorizationId: string,
      confirmation: string,
    ) {
      assertAdmin(actor);
      await dependencies.assertExecutionEnabled(actor, confirmation);
      const session = await getOwnedSession(actor, sessionId);
      await assertAuthorization(actor, session, authorizationId, 'RECONCILE');
      const { lifecycle, exchange, scope } = await createLifecycle(
        actor as AdminDemoActor & { role: 'admin' }, session, authorizationId,
      );
      const record = await dependencies.repository.getExecution(scope);
      if (!record) throw new Error('Admin Demo execution is unavailable for reconciliation.');
      const execution: LifecycleExecution = {
        symbol: record.symbol,
        direction: record.direction,
        quantity: record.quantity,
        stopPrice: record.stop_loss,
        tp1Price: record.tp1_price,
        tp2Price: record.tp2_price,
        tp3Price: record.tp3_price,
        tickSize: record.tick_size,
        closeClientOrderId: `adclose${session.id}`.slice(0, 36),
      };
      const progress = await exchange.getTargetProgress(scope, execution);
      const result = await lifecycle.reconcile(scope, execution, progress);
      return { result, progress, sessionId: session.id, environment: 'DEMO' as const };
    },
    async getStatus(actor: AdminDemoActor, sessionId: string) {
      const session = await getOwnedSession(actor, sessionId);
      const scope = {
        kind: 'ADMIN_DEMO_TEST',
        adminUserId: actor.id,
        testAccountId: session.testAccountId,
        sessionId: session.id,
        executionId: session.id,
        authorizationId: '1',
        strategy: 'STANDARD',
        environment: 'DEMO',
      } satisfies ExecutionScope;
      const record = await dependencies.repository.getExecution(scope);
      return { session, execution: record };
    },
    async getHistory(actor: AdminDemoActor, sessionId: string) {
      await getOwnedSession(actor, sessionId);
      return dependencies.repository.getSessionHistory(actor.id, sessionId);
    },
  };
}

export async function createProductionAdminDemoExecutionService(
  options: { transport?: BinanceDemoTransport } = {},
) {
  if (process.env.SMARTEXIT_ADMIN_BINANCE_DEMO_LAB_ENABLED !== 'true') {
    throw new Error('Admin Binance Demo service is disabled.');
  }
  const dbQuery: AdminDemoQuery = (sql, values) => query(sql, values);
  const authorization = await createServerAdminDemoAuthorizationRepository();
  const repository = createAdminDemoExecutionRepository(dbQuery);
  const lifecycle: ExecutionLifecycleDependencies = {
    authorization: { async assertAuthorized() { throw new Error('Admin Demo lifecycle authorization must use its service policy.'); } },
    environment: { async assertEnvironment() { throw new Error('Admin Demo lifecycle environment must use its service policy.'); } },
    exchange: {
      async installProtection() { throw new Error('Admin Demo exchange adapter is not initialized.'); },
      async verifyProtection() { return false; },
      async getPosition() { throw new Error('Admin Demo exchange adapter is not initialized.'); },
      async closePositionAndVerify() { return { closed: false }; },
      async cancelObsoleteProtection() { throw new Error('Admin Demo exchange adapter is not initialized.'); },
    },
    executions: repository.executions,
    entries: repository.entries,
    protections: repository.protections,
    reconciliation: repository.reconciliation,
    events: repository.events,
  };
  return createAdminDemoExecutionService({
    repository: {
      ...repository,
      lifecycle,
    },
    authorization,
    async loadCredentials(adminUserId, testAccountId) {
      return loadAdminDemoCredentials(dbQuery, adminUserId, testAccountId);
    },
    createExchange: (credentials, records, transport) =>
      createAdminBinanceDemoExecutionPort(credentials, records, transport),
    transport: options.transport,
    async assertExecutionEnabled(_actor, confirmation) {
      if (!isAdminDemoExecutionRequestApproved(process.env, confirmation)) {
        throw new Error('Admin Demo execution requires the approved Staging target, disabled persistent trading gates, no persistent remote-test flag, and explicit operator confirmation.');
      }
    },
  });
}
