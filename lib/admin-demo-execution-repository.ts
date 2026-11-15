import 'server-only';

import { randomUUID } from 'node:crypto';
import type {
  EntryExecutionRepository,
  EntryOrderResult,
  EntryRequest,
  ExecutionRepository,
  ExecutionScope,
  LifecycleEventPublisher,
  ProtectionIdentifiers,
  ProtectionRepository,
  ReconciliationRepository,
} from './execution-lifecycle';
import type { AdminDemoAction } from './admin-demo-authorization';

export type AdminDemoQueryResult<Row> = { rows: Row[]; rowCount?: number | null };
export type AdminDemoQuery = <Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  values?: readonly unknown[],
) => Promise<AdminDemoQueryResult<Row>>;

export type AdminDemoSession = {
  id: string;
  adminUserId: number;
  testAccountId: string;
  status: string;
  symbol: string | null;
  direction: 'LONG' | 'SHORT' | null;
  createdAt: string;
  authorizationExpiresAt: string | null;
};

export type AdminDemoExecutionRecord = {
  session_id: string;
  admin_user_id: number;
  authorization_id: string;
  test_account_id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  entry_client_order_id: string;
  entry_exchange_order_id: string | null;
  execution_status: string;
  stop_algo_order_id: string | null;
  tp3_algo_order_id: string | null;
  trailing_algo_order_id: string | null;
  stop_client_algo_id: string;
  tp3_client_algo_id: string;
  trailing_client_algo_id: string;
  entry_price: string;
  stop_loss: string;
  tp1_price: string;
  tp2_price: string;
  tp3_price: string;
  tick_size: string;
  leverage: number;
  tp1_reached_at: string | null;
  tp2_reached_at: string | null;
  protection_status: string;
  reconcile_lock_token: string | null;
  reconcile_lock_until: string | null;
};

const sessionIdPattern = /^[1-9]\d*$/;
const safeEventDetail = /^[A-Z0-9_]{1,48}$/;
const safeEventDetailValues: Record<string, RegExp> = {
  symbol: /^[A-Z0-9]{2,30}$/,
  direction: /^(LONG|SHORT)$/,
  environment: /^DEMO$/,
  lifecycleEvent: /^(ENTRY_SUBMITTED|ENTRY_UNCERTAIN|PROTECTION_VERIFIED|EXECUTION_CLOSED|RECONCILIATION_UNCERTAIN)$/,
};

function assertAdminScope(scope: ExecutionScope): asserts scope is Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }> {
  if (
    scope.kind !== 'ADMIN_DEMO_TEST' ||
    scope.environment !== 'DEMO' ||
    scope.strategy !== 'STANDARD' ||
    !Number.isSafeInteger(scope.adminUserId) ||
    scope.adminUserId <= 0 ||
    !sessionIdPattern.test(scope.sessionId) ||
    scope.executionId !== scope.sessionId ||
    !sessionIdPattern.test(scope.testAccountId) ||
    !sessionIdPattern.test(scope.authorizationId)
  ) {
    throw new Error('Admin Demo execution scope is invalid.');
  }
}

function requiredRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) throw new Error(message);
  return row;
}

function orderClientId(prefix: string) {
  return `${prefix}${randomUUID().replaceAll('-', '')}`.slice(0, 36);
}

export function createAdminDemoExecutionRepository(db: AdminDemoQuery) {
  let lockToken: string | null = null;
  let lockScope: Extract<ExecutionScope, { kind: 'ADMIN_DEMO_TEST' }> | null = null;

  async function getSession(adminUserId: number, sessionId: string): Promise<AdminDemoSession | null> {
    if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0 || !sessionIdPattern.test(sessionId)) return null;
    const result = await db<{
      id: string;
      admin_user_id: number;
      test_account_id: string;
      session_status: string;
      symbol: string | null;
      direction: 'LONG' | 'SHORT' | null;
      created_at: string;
      authorization_expires_at: string | null;
      account_revoked_at: string | null;
    }>(
      `SELECT s.id::TEXT, s.admin_user_id, s.test_account_id::TEXT, s.session_status,
              s.symbol, s.direction, s.created_at, s.authorization_expires_at,
              a.revoked_at AS account_revoked_at
         FROM public.admin_demo_test_sessions s
         JOIN public.admin_binance_demo_test_accounts a
           ON a.id = s.test_account_id AND a.admin_user_id = s.admin_user_id
        WHERE s.id = $1 AND s.admin_user_id = $2
          AND s.exchange = 'BINANCE' AND s.environment = 'DEMO'
          AND a.exchange = 'BINANCE' AND a.environment = 'DEMO'
        LIMIT 1`,
      [sessionId, adminUserId],
    );
    const row = result.rows[0];
    if (!row || row.account_revoked_at) return null;
    return {
      id: row.id,
      adminUserId: row.admin_user_id,
      testAccountId: row.test_account_id,
      status: row.session_status,
      symbol: row.symbol,
      direction: row.direction,
      createdAt: row.created_at,
      authorizationExpiresAt: row.authorization_expires_at,
    };
  }

  async function getExecution(scope: ExecutionScope): Promise<AdminDemoExecutionRecord | null> {
    assertAdminScope(scope);
    const result = await db<AdminDemoExecutionRecord>(
      `SELECT e.session_id::TEXT, e.admin_user_id, e.authorization_id::TEXT,
              s.test_account_id::TEXT, e.symbol, e.direction, e.quantity::TEXT,
              e.entry_client_order_id, e.entry_exchange_order_id, e.execution_status,
              e.stop_algo_order_id, e.tp3_algo_order_id, e.trailing_algo_order_id,
              e.stop_client_algo_id, e.tp3_client_algo_id, e.trailing_client_algo_id,
              e.entry_price::TEXT, e.stop_loss::TEXT, e.tp1_price::TEXT, e.tp2_price::TEXT,
              e.tp3_price::TEXT, e.tick_size::TEXT, e.leverage, e.tp1_reached_at,
              e.tp2_reached_at, e.protection_status, e.reconcile_lock_token::TEXT,
              e.reconcile_lock_until
         FROM public.admin_demo_test_executions e
         JOIN public.admin_demo_test_sessions s
           ON s.id = e.session_id AND s.admin_user_id = e.admin_user_id
        WHERE e.session_id = $1 AND e.admin_user_id = $2
          AND s.test_account_id = $3
          AND e.exchange = 'BINANCE' AND e.environment = 'DEMO'
        LIMIT 1`,
      [scope.sessionId, scope.adminUserId, scope.testAccountId],
    );
    return result.rows[0] ?? null;
  }

  function lockPredicate(scope: ExecutionScope) {
    assertAdminScope(scope);
    if (lockToken && lockScope?.sessionId === scope.sessionId &&
        lockScope.adminUserId === scope.adminUserId) {
      return { predicate: 'AND e.reconcile_lock_token = $4::UUID', values: [lockToken] };
    }
      return { predicate: 'AND e.reconcile_lock_token IS NULL', values: [null] };
  }

  async function updateExecution(
    scope: ExecutionScope,
    assignments: string,
    values: readonly unknown[],
    message: string,
  ) {
    assertAdminScope(scope);
    const lock = lockPredicate(scope);
    const result = await db(
      `UPDATE public.admin_demo_test_executions e
          SET ${assignments}, updated_at = NOW()
         FROM public.admin_demo_test_sessions s
        WHERE e.session_id = $1 AND e.admin_user_id = $2
          AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
          AND s.test_account_id = $3
          AND e.exchange = 'BINANCE' AND e.environment = 'DEMO'
          ${lock.predicate}
        RETURNING e.session_id`,
      [scope.sessionId, scope.adminUserId, scope.testAccountId, ...lock.values, ...values],
    );
    if (!result.rows[0]) throw new Error(message);
  }

  const executions: ExecutionRepository = {
    async assertScope(scope) {
      assertAdminScope(scope);
      if (!(await getSession(scope.adminUserId, scope.sessionId))) {
        throw new Error('Admin Demo session is missing, revoked, or not owned by this administrator.');
      }
      const result = await getExecution(scope);
      if (!result) throw new Error('Admin Demo execution is unavailable for this session.');
      if (result.authorization_id !== scope.authorizationId) {
        throw new Error('Admin Demo execution authorization does not match this session.');
      }
    },
    async markProtected(scope, identifiers) {
      await updateExecution(
        scope,
        `execution_status = 'PROTECTED', protection_status =
           CASE WHEN e.tp1_reached_at IS NOT NULL THEN 'TRAILING' ELSE 'PROTECTED' END,
         stop_algo_order_id = $5, tp3_algo_order_id = $6,
         trailing_algo_order_id = $7`,
        [identifiers.stopAlgoId, identifiers.tp3AlgoId, identifiers.trailingAlgoId],
        'Admin Demo execution changed or its reconciliation lock was lost.',
      );
    },
    async markClosed(scope) {
      assertAdminScope(scope);
      await updateExecution(
        scope,
        `execution_status = 'CLOSED', protection_status = 'CLOSED', closed_at = NOW()`,
        [],
        'Admin Demo execution changed or its reconciliation lock was lost.',
      );
      const sessionUpdate = await db(
        `UPDATE public.admin_demo_test_sessions
            SET session_status = 'PASSED', ended_at = NOW(),
                result_summary = 'Position closure and protection cleanup verified.'
          WHERE id = $1 AND admin_user_id = $2 AND test_account_id = $3
            AND environment = 'DEMO' AND session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
          RETURNING id`,
        [scope.sessionId, scope.adminUserId, scope.testAccountId],
      );
      if (!sessionUpdate.rows[0]) throw new Error('Admin Demo session could not be marked closed.');
    },
    async markUncertain(scope, reason) {
      void reason;
      assertAdminScope(scope);
      await updateExecution(
        scope,
        `execution_status = 'RECONCILIATION_REQUIRED'`,
        [],
        'Admin Demo execution changed or its reconciliation lock was lost.',
      );
      const sessionUpdate = await db(
        `UPDATE public.admin_demo_test_sessions
            SET session_status = 'RECONCILIATION_REQUIRED',
                result_summary = 'Exchange state requires reconciliation.'
          WHERE id = $1 AND admin_user_id = $2 AND test_account_id = $3
            AND session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
          RETURNING id`,
        [scope.sessionId, scope.adminUserId, scope.testAccountId],
      );
      if (!sessionUpdate.rows[0]) throw new Error('Admin Demo session could not be marked for reconciliation.');
    },
  };

  const entries: EntryExecutionRepository = {
    async reserveEntry(scope, request: EntryRequest) {
      assertAdminScope(scope);
      const entryPrice = 'entryPrice' in request ? request.entryPrice : undefined;
      if (!entryPrice || !/^\d+(?:\.\d+)?$/.test(entryPrice)) {
        throw new Error('Admin Demo entry price is missing or invalid.');
      }
      const session = await getSession(scope.adminUserId, scope.sessionId);
      if (
        !session ||
        session.testAccountId !== scope.testAccountId ||
        session.status !== 'RUNNING' ||
        session.symbol !== request.execution.symbol ||
        session.direction !== request.execution.direction
      ) throw new Error('Admin Demo session does not match the authorized test configuration.');

      const created = await db(
        `INSERT INTO public.admin_demo_test_executions (
           session_id, admin_user_id, authorization_id, exchange, environment,
           symbol, direction, quantity, entry_client_order_id, execution_status,
           stop_client_algo_id, tp3_client_algo_id, trailing_client_algo_id,
           entry_price, stop_loss, tp1_price, tp2_price, tp3_price, tick_size, leverage
         ) VALUES (
           $1, $2, $3, 'BINANCE', 'DEMO', $4, $5, $6, $7, 'ENTRY_SUBMITTING',
           $8, $9, $10, $11, $12, $13, $14, $15, $16, 1
         )
         ON CONFLICT (session_id) DO NOTHING
         RETURNING session_id`,
        [
          scope.sessionId, scope.adminUserId, scope.authorizationId,
          request.execution.symbol, request.execution.direction,
          request.execution.quantity, request.clientOrderId,
          orderClientId('st'), orderClientId('tp'), orderClientId('tr'),
          entryPrice, request.execution.stopPrice, request.execution.tp1Price,
          request.execution.tp2Price, request.execution.tp3Price, request.execution.tickSize,
        ],
      );
      if (created.rows[0]) return 'CREATED';

      const existing = await getExecution(scope);
      if (
        existing &&
        existing.authorization_id === scope.authorizationId &&
        existing.entry_client_order_id === request.clientOrderId &&
        existing.symbol === request.execution.symbol &&
        existing.direction === request.execution.direction &&
        existing.quantity === request.execution.quantity &&
        existing.entry_price === entryPrice
      ) return 'EXISTING';
      return 'BUSY';
    },
    async markEntryUncertain(scope, reason) {
      await updateExecution(
        scope,
        `execution_status = 'ENTRY_UNKNOWN'`,
        [],
        'Admin Demo entry state could not be updated.',
      );
      await appendEvent(scope, 'RECONCILIATION_REQUIRED', 'UNCERTAIN', { reason });
    },
    async markEntryFailed(scope, reason) {
      await updateExecution(
        scope,
        `execution_status = 'FAILED', protection_status = 'FAILED'`,
        [],
        'Admin Demo entry state could not be updated.',
      );
      await appendEvent(scope, 'TEST_FAILED', 'FAILED', { reason });
    },
    async markEntryFilled(scope, order: EntryOrderResult) {
      await updateExecution(
        scope,
        `execution_status = 'ENTRY_FILLED',
         entry_exchange_order_id = $5,
         quantity = $6`,
        [order.orderId, order.executedQuantity],
        'Admin Demo entry fill could not be persisted.',
      );
    },
  };

  const protections: ProtectionRepository = {
    async loadProtectionIdentifiers(scope) {
      const record = await getExecution(scope);
      if (!record?.stop_algo_order_id || !record.tp3_algo_order_id || !record.trailing_algo_order_id) return null;
      return {
        stopAlgoId: record.stop_algo_order_id,
        tp3AlgoId: record.tp3_algo_order_id,
        trailingAlgoId: record.trailing_algo_order_id,
      };
    },
    async markProtectionVerified(scope, identifiers: ProtectionIdentifiers, progress) {
      await updateExecution(
        scope,
        `stop_algo_order_id = $5, tp3_algo_order_id = $6,
         trailing_algo_order_id = $7,
         tp1_reached_at = CASE WHEN $8 THEN COALESCE(e.tp1_reached_at, NOW()) ELSE e.tp1_reached_at END,
         tp2_reached_at = CASE WHEN $9 THEN COALESCE(e.tp2_reached_at, NOW()) ELSE e.tp2_reached_at END,
         protection_status = CASE WHEN $10 THEN 'TRAILING' ELSE 'PROTECTED' END`,
        [
          identifiers.stopAlgoId, identifiers.tp3AlgoId, identifiers.trailingAlgoId,
          progress.tp1Reached, progress.tp2Reached, progress.trailingActivated,
        ],
        'Admin Demo protection state changed or its reconciliation lock was lost.',
      );
    },
    async markProtectionFailed(scope) {
      await updateExecution(
        scope,
        `protection_status = 'FAILED', execution_status = 'RECONCILIATION_REQUIRED'`,
        [],
        'Admin Demo protection failure could not be persisted.',
      );
    },
  };

  const reconciliation: ReconciliationRepository = {
    async claim(scope) {
      assertAdminScope(scope);
      if (lockToken) return false;
      const candidate = randomUUID();
      const result = await db(
        `UPDATE public.admin_demo_test_executions e
            SET reconcile_lock_token = $4::UUID,
                reconcile_lock_until = NOW() + INTERVAL '60 seconds',
                updated_at = NOW()
           FROM public.admin_demo_test_sessions s
          WHERE e.session_id = $1 AND e.admin_user_id = $2
            AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
            AND s.test_account_id = $3 AND e.environment = 'DEMO'
            AND e.execution_status IN ('ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED', 'RECONCILIATION_REQUIRED')
            AND (e.reconcile_lock_until IS NULL OR e.reconcile_lock_until < NOW())
          RETURNING e.session_id`,
        [scope.sessionId, scope.adminUserId, scope.testAccountId, candidate],
      );
      if (!result.rows[0]) return false;
      lockToken = candidate;
      lockScope = scope;
      return true;
    },
    async release(scope) {
      assertAdminScope(scope);
      if (!lockToken || !lockScope || lockScope.sessionId !== scope.sessionId ||
          lockScope.adminUserId !== scope.adminUserId) return;
      const released = await db(
        `UPDATE public.admin_demo_test_executions e
            SET reconcile_lock_token = NULL, reconcile_lock_until = NULL, last_reconciled_at = NOW(),
                updated_at = NOW()
           FROM public.admin_demo_test_sessions s
          WHERE e.session_id = $1 AND e.admin_user_id = $2
            AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
            AND s.test_account_id = $3 AND e.reconcile_lock_token = $4::UUID
          RETURNING e.session_id`,
        [scope.sessionId, scope.adminUserId, scope.testAccountId, lockToken],
      );
      if (!released.rows[0]) throw new Error('Admin Demo reconciliation lock was lost before release.');
      lockToken = null;
      lockScope = null;
    },
  };

  async function appendEvent(
    scope: ExecutionScope,
    eventType: string,
    eventStatus: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'BLOCKED',
    details: Record<string, string | number | boolean | null>,
  ) {
    assertAdminScope(scope);
    if (!safeEventDetail.test(eventType)) throw new Error('Admin Demo audit event type is invalid.');
    const safeDetails = Object.fromEntries(
      Object.entries(details).filter(([key, value]) =>
        safeEventDetailValues[key]?.test(String(value)) === true,
      ),
    );
    await db(
      `INSERT INTO public.admin_demo_test_events (
         session_id, execution_id, authorization_id, admin_user_id,
         event_type, event_status, safe_details
       )
       SELECT $1, e.id, $4, $2, $5, $6, $7::JSONB
         FROM public.admin_demo_test_sessions s
         LEFT JOIN public.admin_demo_test_executions e
           ON e.session_id = s.id AND e.admin_user_id = s.admin_user_id
        WHERE s.id = $1 AND s.admin_user_id = $2 AND s.test_account_id = $3
          AND s.environment = 'DEMO'
       RETURNING id`,
      [scope.sessionId, scope.adminUserId, scope.testAccountId, scope.authorizationId,
        eventType, eventStatus, JSON.stringify(safeDetails)],
    );
  }

  const events: LifecycleEventPublisher = {
    async publish(event) {
      const mapping: Record<string, [string, 'SUCCEEDED' | 'UNCERTAIN']> = {
        ENTRY_SUBMITTED: ['ENTRY_SUBMITTED', 'SUCCEEDED'],
        ENTRY_UNCERTAIN: ['RECONCILIATION_REQUIRED', 'UNCERTAIN'],
        PROTECTION_VERIFIED: ['PROTECTION_VERIFIED', 'SUCCEEDED'],
        EXECUTION_CLOSED: ['POSITION_CLOSED', 'SUCCEEDED'],
        RECONCILIATION_UNCERTAIN: ['RECONCILIATION_REQUIRED', 'UNCERTAIN'],
      };
      const mapped = mapping[event.type];
      if (!mapped) throw new Error('Unsupported Admin Demo lifecycle event.');
      await appendEvent(event.scope, mapped[0], mapped[1], { lifecycleEvent: event.type });
    },
  };

  async function createSession(adminUserId: number, symbol: string, direction: 'LONG' | 'SHORT') {
    if (
      !Number.isSafeInteger(adminUserId) ||
      adminUserId <= 0 ||
      !/^[A-Z0-9]{2,30}$/.test(symbol) ||
      !['LONG', 'SHORT'].includes(direction)
    ) throw new Error('Admin Demo session input is invalid.');
    const result = await db<{
      id: string;
      admin_user_id: number;
      test_account_id: string;
      session_status: string;
      symbol: string;
      direction: 'LONG' | 'SHORT';
      created_at: string;
      authorization_expires_at: string | null;
    }>(
      `WITH credential_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtext('smart_exit_admin_demo_credentials:' || $1::TEXT))
       ), eligible_account AS MATERIALIZED (
         SELECT a.admin_user_id, a.id
           FROM public.admin_binance_demo_test_accounts a
           CROSS JOIN credential_lock
          WHERE a.admin_user_id = $1 AND a.exchange = 'BINANCE' AND a.environment = 'DEMO'
            AND a.owner_confirmed_at IS NOT NULL AND a.revoked_at IS NULL
          FOR UPDATE OF a
       ), created_session AS (
         INSERT INTO public.admin_demo_test_sessions (
           admin_user_id, test_account_id, exchange, environment, symbol, direction
         )
         SELECT a.admin_user_id, a.id, 'BINANCE', 'DEMO', $2, $3
           FROM eligible_account a
         RETURNING id::TEXT, admin_user_id, test_account_id::TEXT, session_status,
                   symbol, direction, created_at, authorization_expires_at
       )
       SELECT id, admin_user_id, test_account_id, session_status,
              symbol, direction, created_at, authorization_expires_at
         FROM created_session`,
      [adminUserId, symbol, direction],
    );
    const row = requiredRow(result.rows, 'Dedicated, owner-confirmed Admin Demo credentials are not configured.');
    return {
      id: row.id,
      adminUserId: row.admin_user_id,
      testAccountId: row.test_account_id,
      status: row.session_status,
      symbol: row.symbol,
      direction: row.direction,
      createdAt: row.created_at,
      authorizationExpiresAt: row.authorization_expires_at,
    } satisfies AdminDemoSession;
  }

  async function createAuthorization(
    adminUserId: number,
    sessionId: string,
    expiresInSeconds: number,
    actions: readonly AdminDemoAction[] = ['START_TEST', 'RECONCILE'],
  ) {
    if (
      !Number.isSafeInteger(adminUserId) || adminUserId <= 0 ||
      !sessionIdPattern.test(sessionId) ||
      !Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 900 ||
      actions.length === 0 || actions.some((action) => !['START_TEST', 'RECONCILE'].includes(action)) ||
      new Set(actions).size !== actions.length
    ) throw new Error('Admin Demo authorization request is invalid.');
    const result = await db<{
      id: string;
      admin_user_id: number;
      session_id: string;
      test_account_id: string;
      exchange: string;
      environment: string;
      expires_at: string;
    }>(
      `WITH owned_session AS MATERIALIZED (
         SELECT s.id, s.admin_user_id, s.test_account_id
           FROM public.admin_demo_test_sessions s
           JOIN public.admin_binance_demo_test_accounts a
             ON a.id = s.test_account_id AND a.admin_user_id = s.admin_user_id
          WHERE s.id = $1 AND s.admin_user_id = $2 AND s.environment = 'DEMO'
            AND s.session_status = 'CREATED' AND a.revoked_at IS NULL
          FOR UPDATE OF s
       ), revoked AS (
         UPDATE public.admin_demo_test_authorizations
            SET revoked_at = NOW()
          WHERE session_id = $1 AND admin_user_id = $2 AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM owned_session)
          RETURNING id
       ), authorized_session AS (
         UPDATE public.admin_demo_test_sessions
            SET session_status = 'AUTHORIZED',
                authorization_expires_at = NOW() + ($3 * INTERVAL '1 second')
          WHERE id = $1 AND admin_user_id = $2 AND session_status = 'CREATED'
            AND EXISTS (SELECT 1 FROM owned_session)
          RETURNING id, admin_user_id, test_account_id
       ), created AS (
         INSERT INTO public.admin_demo_test_authorizations (
           session_id, admin_user_id, exchange, environment, permitted_actions, expires_at
         )
         SELECT id, admin_user_id, 'BINANCE', 'DEMO', $4::TEXT[],
                NOW() + ($3 * INTERVAL '1 second')
           FROM authorized_session
          WHERE (SELECT COUNT(*) FROM revoked) >= 0
         RETURNING id, admin_user_id, session_id, exchange, environment, expires_at
       ), audit AS (
         INSERT INTO public.admin_demo_test_events (
           session_id, authorization_id, admin_user_id, event_type, event_status, safe_details
         )
         SELECT c.session_id, c.id, c.admin_user_id, 'AUTHORIZATION_CREATED', 'SUCCEEDED',
                jsonb_build_object('exchange', 'BINANCE', 'environment', 'DEMO',
                                   'expiresAt', c.expires_at)
           FROM created c
         RETURNING id
       )
       SELECT c.id::TEXT, c.admin_user_id, c.session_id::TEXT,
              s.test_account_id::TEXT, c.exchange, c.environment, c.expires_at
         FROM created c
         JOIN public.admin_demo_test_sessions s ON s.id = c.session_id
        WHERE (SELECT COUNT(*) FROM audit) >= 0`,
      [sessionId, adminUserId, expiresInSeconds, [...actions]],
    );
    const row = requiredRow(result.rows, 'Admin Demo session is not available for authorization.');
    return {
      id: row.id,
      adminUserId: row.admin_user_id,
      sessionId: row.session_id,
      testAccountId: row.test_account_id,
      exchange: row.exchange,
      environment: row.environment,
      status: 'ACTIVE' as const,
      permittedActions: actions,
      expiresAt: row.expires_at,
      consumedAt: null,
    };
  }

  async function revokeAuthorization(adminUserId: number, sessionId: string, authorizationId: string) {
    if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0 ||
        !sessionIdPattern.test(sessionId) || !sessionIdPattern.test(authorizationId)) {
      throw new Error('Admin Demo authorization scope is invalid.');
    }
    const reset = await db(
      `WITH revoked AS (
         UPDATE public.admin_demo_test_authorizations a
            SET revoked_at = NOW()
           FROM public.admin_demo_test_sessions s
          WHERE a.id = $1 AND a.session_id = $2 AND a.admin_user_id = $3
            AND s.id = a.session_id AND s.admin_user_id = a.admin_user_id
            AND s.session_status IN ('CREATED', 'AUTHORIZED')
            AND a.revoked_at IS NULL AND a.consumed_at IS NULL
          RETURNING a.id, a.session_id, a.admin_user_id
       ), reset_session AS (
         UPDATE public.admin_demo_test_sessions s
            SET session_status = 'CREATED', authorization_expires_at = NULL
          WHERE s.id = $2 AND s.admin_user_id = $3 AND s.session_status = 'AUTHORIZED'
            AND EXISTS (SELECT 1 FROM revoked)
          RETURNING s.id
       )
       INSERT INTO public.admin_demo_test_events (
         session_id, authorization_id, admin_user_id, event_type, event_status, safe_details
       )
       SELECT session_id, id, admin_user_id, 'AUTHORIZATION_REVOKED', 'SUCCEEDED',
              '{"exchange":"BINANCE","environment":"DEMO"}'::JSONB
         FROM revoked
      WHERE (SELECT COUNT(*) FROM reset_session) >= 0
     RETURNING authorization_id::TEXT`,
      [authorizationId, sessionId, adminUserId],
    );
    return Boolean(reset.rows[0]);
  }

  async function getSessionHistory(adminUserId: number, sessionId: string) {
    if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0 || !sessionIdPattern.test(sessionId)) {
      throw new Error('Admin Demo session scope is invalid.');
    }
    const result = await db(
      `SELECT e.event_type, e.event_status, e.safe_details, e.created_at
         FROM public.admin_demo_test_events e
         JOIN public.admin_demo_test_sessions s
           ON s.id = e.session_id AND s.admin_user_id = e.admin_user_id
        WHERE e.session_id = $1 AND e.admin_user_id = $2
          AND s.environment = 'DEMO'
        ORDER BY e.created_at DESC LIMIT 100`,
      [sessionId, adminUserId],
    );
    return result.rows;
  }

  async function appendAudit(scope: ExecutionScope, eventType: string, status: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'BLOCKED', details: Record<string, string | number | boolean | null>) {
    await appendEvent(scope, eventType, status, details);
  }

  async function authorizeWithRpc(
    auth: (context: {
      adminUserId: number;
      sessionId: string;
      testAccountId: string;
      authorizationId: string;
      exchange: 'BINANCE';
      environment: 'DEMO';
      action: AdminDemoAction;
    }) => Promise<unknown>,
    context: {
      adminUserId: number;
      sessionId: string;
      testAccountId: string;
      authorizationId: string;
      action: AdminDemoAction;
    },
  ) {
    return auth({ ...context, exchange: 'BINANCE', environment: 'DEMO' });
  }

  return {
    getSession,
    getExecution,
    createSession,
    createAuthorization,
    revokeAuthorization,
    getSessionHistory,
    appendAudit,
    authorizeWithRpc,
    executions,
    entries,
    protections,
    reconciliation,
    events,
  };
}
