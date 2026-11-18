import 'server-only';

import {
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  ADMIN_DEMO_PROVIDERS,
  isAdminDemoProvider,
  type AdminDemoProvider,
  type AdminDemoProviderEnvironment,
} from './admin-demo-provider-contract';
import { decryptCredential, encryptCredential } from './binance-credentials';
import type {
  AdminDemoProviderAuditEvent,
  AdminDemoProviderAuthorization,
  AdminDemoProviderAuthorizationAction,
  AdminDemoProviderCredential,
  AdminDemoProviderCredentialInput,
  AdminDemoProviderCredentialStatus,
  AdminDemoProviderExecution,
  AdminDemoProviderExecutionInput,
  AdminDemoProviderExecutionStatus,
  AdminDemoProviderExecutionSummary,
  AdminDemoProviderProtectionStatus,
  AdminDemoProviderRepository,
  AdminDemoProviderSession,
  AdminDemoProviderSessionInput,
} from './admin-demo-provider-backend-contract';

export type AdminDemoProviderQueryResult<Row> = { rows: Row[]; rowCount?: number | null };
export type AdminDemoProviderQuery = <Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  values?: readonly unknown[],
) => Promise<AdminDemoProviderQueryResult<Row>>;
export type AdminDemoProviderRepositoryDependencies = {
  query: AdminDemoProviderQuery;
  transaction: <Result>(
    work: (query: AdminDemoProviderQuery) => Promise<Result>,
  ) => Promise<Result>;
  rpc: (
    functionName: 'authorize_admin_demo_exchange_action',
    parameters: {
      p_admin_user_id: number;
      p_admin_scope: 'ADMIN';
      p_session_id: string;
      p_authorization_id: string;
      p_provider: AdminDemoProvider;
      p_environment: AdminDemoProviderEnvironment;
      p_action: AdminDemoProviderAuthorizationAction;
    },
  ) => Promise<{ data: unknown; error: { code?: string } | null }>;
};

const schemaMigration = '202611110007_admin_demo_exchange_neutral.sql';
const executionStatuses = new Set([
  'CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED',
  'RECONCILIATION_REQUIRED', 'CLOSED', 'FAILED', 'REVOKED',
]);
const protectionStatuses = new Set(['PENDING', 'PROTECTED', 'TRAILING', 'FAILED', 'CLOSED']);
const auditEventTypes = new Set([
  'CREDENTIAL_SAVED', 'CREDENTIAL_REVOKED', 'CONNECTION_TESTED', 'BALANCE_READ',
  'INSTRUMENTS_READ', 'POSITIONS_READ', 'PREFLIGHT_COMPLETED', 'AUTHORIZATION_CREATED',
  'AUTHORIZATION_REVOKED', 'TEST_STARTED', 'ENTRY_SUBMITTED', 'ENTRY_RECONCILED',
  'PROTECTION_VERIFIED', 'RECONCILIATION_STARTED', 'RECONCILIATION_REQUIRED',
  'POSITION_CLOSED', 'TEST_PASSED', 'TEST_FAILED', 'EXECUTION_BLOCKED',
]);
const eventStatuses = new Set(['SUCCEEDED', 'FAILED', 'UNCERTAIN', 'BLOCKED']);
const actions = new Set(['START_TEST', 'RECONCILE']);
const safeDetailValues: Record<string, ReadonlySet<string>> = {
  direction: new Set(['LONG', 'SHORT']),
  environment: new Set(['DEMO', 'TESTNET']),
  action: actions,
  lifecycleEvent: new Set([
    'ENTRY_SUBMITTED', 'ENTRY_UNCERTAIN', 'PROTECTION_VERIFIED', 'EXECUTION_CLOSED',
    'RECONCILIATION_UNCERTAIN',
  ]),
  executionStatus: executionStatuses,
  protectionStatus: protectionStatuses,
  milestone: new Set(['TP1', 'TP2']),
  reason: new Set(['TP2_TRAILING_UPDATE_UNSUPPORTED', 'LIFECYCLE_STATE_UNVERIFIED']),
};
const idPattern = /^[1-9]\d*$/;
const symbolPattern = /^[A-Z0-9]{2,30}$/;
const decimalPattern = /^\d{1,18}(?:\.\d{1,12})?$/;
const clientOrderIdPattern = /^[A-Za-z0-9_-]{1,36}$/;

type CredentialRow = {
  id: string;
  admin_user_id: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  api_key_ciphertext: string;
  secret_key_ciphertext: string;
  passphrase_ciphertext: string | null;
  owner_confirmed_at: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};
type SessionRow = {
  id: string;
  admin_user_id: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  credential_id: string;
  session_status: AdminDemoProviderSession['status'];
  symbol: string | null;
  direction: 'LONG' | 'SHORT' | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};
type AuthorizationRow = {
  id: string;
  session_id: string;
  admin_user_id: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  permitted_actions: Array<'START_TEST' | 'RECONCILE'>;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
};
type ExecutionRow = {
  id: string;
  session_id: string;
  authorization_id?: string;
  admin_user_id: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry_order_type: 'MARKET' | 'LIMIT';
  execution_status: string;
  protection_status: string;
  entry_client_order_id?: string;
  entry_exchange_order_id?: string | null;
  quantity?: string;
  entry_price?: string;
  stop_loss?: string;
  tp1_price?: string;
  tp2_price?: string;
  tp3_price?: string;
  tick_size?: string;
  stop_client_order_id?: string;
  tp3_client_order_id?: string;
  trailing_client_order_id?: string;
  stop_protection_id?: string | null;
  tp3_protection_id?: string | null;
  trailing_protection_id?: string | null;
  tp1_reached_at?: string | null;
  tp2_reached_at?: string | null;
  execution_mode?: 'CONFIRM';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
type AuditRow = {
  id: string;
  session_id: string | null;
  authorization_id: string | null;
  admin_user_id: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  event_type: string;
  event_status: AdminDemoProviderAuditEvent['eventStatus'];
  safe_details: Record<string, unknown> | string | null;
  created_at: string;
};

function schemaError(error: unknown): Error | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['42P01', '42703', '42883', '42704', '3F000'].includes(code)) {
    return new Error(
      `Admin Demo provider schema is missing or outdated. Apply ${schemaMigration} before using this repository.`,
    );
  }
  return null;
}

function databaseError(error: unknown): Error {
  const missingSchema = schemaError(error);
  if (missingSchema) return missingSchema;
  if ((error as { code?: unknown } | null)?.code === '23505') {
    return Object.assign(new Error('Admin Demo provider repository conflict.'), { code: '23505' });
  }
  return new Error('Admin Demo provider repository operation failed.');
}

function assertAdmin(adminUserId: number) {
  if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0) {
    throw new Error('Admin Demo administrator identity is invalid.');
  }
}

function assertProvider(provider: AdminDemoProvider): AdminDemoProviderEnvironment {
  if (!isAdminDemoProvider(provider)) throw new Error('Admin Demo provider is invalid.');
  return ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];
}

function assertId(id: string, label: string) {
  if (!idPattern.test(id)) throw new Error(`Admin Demo ${label} identifier is invalid.`);
}

function assertLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Admin Demo history limit must be between 1 and 100.');
  }
}

function assertExpiry(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    throw new Error('Admin Demo authorization expiry must be between 1 and 900 seconds.');
  }
}

function mapCredentialStatus(
  provider: AdminDemoProvider,
  environment: AdminDemoProviderEnvironment,
  row?: Pick<CredentialRow, 'owner_confirmed_at' | 'is_enabled' | 'created_at' | 'updated_at' | 'revoked_at'>,
): AdminDemoProviderCredentialStatus {
  return {
    provider,
    environment,
    configured: Boolean(row && !row.revoked_at),
    ownerConfirmed: Boolean(row?.owner_confirmed_at),
    enabled: Boolean(row?.is_enabled && !row.revoked_at),
    revokedAt: row?.revoked_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapSession(row: SessionRow): AdminDemoProviderSession {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    provider: row.provider,
    environment: row.environment,
    credentialId: row.credential_id,
    status: row.session_status,
    symbol: row.symbol,
    direction: row.direction,
    executionMode: 'CONFIRM',
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapAuthorization(row: AuthorizationRow): AdminDemoProviderAuthorization {
  return {
    id: row.id,
    sessionId: row.session_id,
    adminUserId: row.admin_user_id,
    provider: row.provider,
    environment: row.environment,
    permittedActions: [...row.permitted_actions],
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function mapExecution(row: ExecutionRow): AdminDemoProviderExecutionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    adminUserId: row.admin_user_id,
    provider: row.provider,
    environment: row.environment,
    symbol: row.symbol,
    direction: row.direction,
    entryOrderType: row.entry_order_type,
    executionStatus: row.execution_status,
    protectionStatus: row.protection_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function mapDetailedExecution(row: ExecutionRow): AdminDemoProviderExecution {
  if (
    !row.authorization_id ||
    !row.entry_client_order_id ||
    row.quantity === undefined ||
    row.entry_price === undefined ||
    row.stop_loss === undefined ||
    row.tp1_price === undefined ||
    row.tp2_price === undefined ||
    row.tp3_price === undefined ||
    row.tick_size === undefined ||
    !row.stop_client_order_id ||
    !row.tp3_client_order_id ||
    !row.trailing_client_order_id
  ) {
    throw new Error('Admin Demo execution recovery record is incomplete.');
  }
  return {
    ...mapExecution(row),
    authorizationId: row.authorization_id,
    entryClientOrderId: row.entry_client_order_id,
    entryExchangeOrderId: row.entry_exchange_order_id ?? null,
    quantity: row.quantity,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    tp1Price: row.tp1_price,
    tp2Price: row.tp2_price,
    tp3Price: row.tp3_price,
    tickSize: row.tick_size,
    stopClientOrderId: row.stop_client_order_id,
    tp3ClientOrderId: row.tp3_client_order_id,
    trailingClientOrderId: row.trailing_client_order_id,
    stopProtectionId: row.stop_protection_id ?? null,
    tp3ProtectionId: row.tp3_protection_id ?? null,
    trailingProtectionId: row.trailing_protection_id ?? null,
    tp1ReachedAt: row.tp1_reached_at ?? null,
    tp2ReachedAt: row.tp2_reached_at ?? null,
    executionMode: 'CONFIRM',
  };
}

function sanitizeAuditDetails(
  details: Record<string, unknown> | undefined,
  providerEnvironment: AdminDemoProviderEnvironment,
) {
  const safe: Record<string, unknown> = {};
  if (!details || typeof details !== 'object' || Array.isArray(details)) return safe;
  for (const [key, value] of Object.entries(details)) {
    if (key === 'permittedActions' && Array.isArray(value)) {
      const permitted = [...new Set(value.filter(
        (action): action is 'START_TEST' | 'RECONCILE' =>
          typeof action === 'string' && actions.has(action),
      ))];
      if (permitted.length > 0) safe.permittedActions = permitted;
      continue;
    }
    if (['existingProtectionRetained', 'partialExitSubmitted', 'protectionRemovalRequested'].includes(key) &&
        typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    const allowed = safeDetailValues[key];
    if (allowed && typeof value === 'string' && allowed.has(value)) safe[key] = value;
  }
  if (safe.environment && safe.environment !== providerEnvironment) delete safe.environment;
  return safe;
}

function auditDetailsFromRow(value: AuditRow['safe_details'], environment: AdminDemoProviderEnvironment) {
  let details: Record<string, unknown> | undefined;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = undefined;
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    details = value;
  }
  return sanitizeAuditDetails(details, environment);
}

function decimalIsPositive(value: string) {
  return decimalPattern.test(value) && /[1-9]/.test(value);
}

function canonicalDecimal(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

function sameDecimal(left: string | null, right: string | null) {
  return left === null || right === null
    ? left === right
    : canonicalDecimal(left) === canonicalDecimal(right);
}

function assertExecutionInput(input: AdminDemoProviderExecutionInput) {
  assertId(input.sessionId, 'session');
  assertId(input.authorizationId, 'authorization');
  if (!symbolPattern.test(input.symbol) || !['LONG', 'SHORT'].includes(input.direction) ||
      !['MARKET', 'LIMIT'].includes(input.entryOrderType)) {
    throw new Error('Admin Demo execution input is invalid.');
  }
  if ((input.entryOrderType === 'LIMIT') !== (input.limitEntryPrice !== null) ||
      (input.limitEntryPrice !== null && !decimalIsPositive(input.limitEntryPrice)) ||
      ![
        input.quantity, input.entryPrice, input.stopLoss, input.tp1Price,
        input.tp2Price, input.tp3Price, input.tickSize,
      ].every(decimalIsPositive) ||
      ![
        input.entryClientOrderId, input.stopClientOrderId,
        input.tp3ClientOrderId, input.trailingClientOrderId,
      ].every((value) => clientOrderIdPattern.test(value))) {
    throw new Error('Admin Demo execution values are invalid.');
  }
  const prices = [
    input.entryPrice, input.stopLoss, input.tp1Price, input.tp2Price, input.tp3Price,
  ].map(Number);
  const [entry, stop, tp1, tp2, tp3] = prices;
  const ordered = input.direction === 'LONG'
    ? stop! < entry! && entry! < tp1! && tp1! < tp2! && tp2! < tp3!
    : tp3! < tp2! && tp2! < tp1! && tp1! < entry! && entry! < stop!;
  if (!ordered) throw new Error('Admin Demo execution protection prices are invalid.');
  if (new Set([
    input.entryClientOrderId, input.stopClientOrderId,
    input.tp3ClientOrderId, input.trailingClientOrderId,
  ]).size !== 4) {
    throw new Error('Admin Demo execution order identifiers must be unique.');
  }
}

export function createAdminDemoProviderRepository(
  database: AdminDemoProviderRepositoryDependencies,
): AdminDemoProviderRepository {
  const query: AdminDemoProviderQuery = async <Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) => {
    try {
      return await database.query<Row>(sql, values);
    } catch (error) {
      throw databaseError(error);
    }
  };

  async function transaction<Result>(
    work: (tx: AdminDemoProviderQuery) => Promise<Result>,
    duplicateMessage?: string,
  ): Promise<Result> {
    try {
      return await database.transaction(async (rawTx) => {
        const tx: AdminDemoProviderQuery = async <Row extends Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) => {
          try {
            return await rawTx<Row>(sql, values);
          } catch (error) {
            throw databaseError(error);
          }
        };
        return work(tx);
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '23505' && duplicateMessage) throw new Error(duplicateMessage);
      throw schemaError(error) ?? (error instanceof Error ? error : databaseError(error));
    }
  }

  async function appendAuditWith(
    tx: AdminDemoProviderQuery,
    input: {
      adminUserId: number;
      provider: AdminDemoProvider;
      environment: AdminDemoProviderEnvironment;
      sessionId?: string;
      authorizationId?: string;
      eventType: string;
      eventStatus: AdminDemoProviderAuditEvent['eventStatus'];
      safeDetails?: Record<string, unknown>;
    },
  ) {
    if (!auditEventTypes.has(input.eventType) || !eventStatuses.has(input.eventStatus)) {
      throw new Error('Admin Demo audit event is invalid.');
    }
    const hasSession = Boolean(input.sessionId);
    if (hasSession !== Boolean(input.authorizationId)) {
      throw new Error('Admin Demo audit session and authorization scope is invalid.');
    }
    if (input.sessionId) assertId(input.sessionId, 'session');
    if (input.authorizationId) assertId(input.authorizationId, 'authorization');
    const details = sanitizeAuditDetails(input.safeDetails, input.environment);
    await tx(
      `INSERT INTO public.admin_demo_exchange_audit_events (
         session_id, authorization_id, admin_user_id, admin_scope, provider, environment,
         event_type, event_status, safe_details
       )
       VALUES ($1, $2, $3, 'ADMIN', $4::public.admin_demo_provider, $5, $6, $7, $8::JSONB)`,
      [
        input.sessionId ?? null,
        input.authorizationId ?? null,
        input.adminUserId,
        input.provider,
        input.environment,
        input.eventType,
        input.eventStatus,
        JSON.stringify(details),
      ],
    );
  }

  async function getCredentialStatus(
    adminUserId: number,
    provider: AdminDemoProvider,
  ): Promise<AdminDemoProviderCredentialStatus> {
    assertAdmin(adminUserId);
    const environment = assertProvider(provider);
    const result = await query<Pick<CredentialRow,
      'owner_confirmed_at' | 'is_enabled' | 'created_at' | 'updated_at' | 'revoked_at'
    > & Record<string, unknown>>(
      `SELECT owner_confirmed_at, is_enabled, created_at, updated_at, revoked_at
         FROM public.admin_demo_exchange_credentials
        WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
          AND provider = $2::public.admin_demo_provider AND environment = $3
        ORDER BY created_at DESC LIMIT 1`,
      [adminUserId, provider, environment],
    );
    return mapCredentialStatus(provider, environment, result.rows[0]);
  }

  async function getSession(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
  ): Promise<AdminDemoProviderSession | null> {
    assertAdmin(adminUserId);
    const environment = assertProvider(provider);
    if (!idPattern.test(sessionId)) return null;
    const result = await query<SessionRow & Record<string, unknown>>(
      `SELECT s.id::TEXT, s.admin_user_id, s.provider, s.environment,
              s.credential_id::TEXT, s.session_status, s.symbol, s.direction,
              s.created_at, s.started_at, s.ended_at
         FROM public.admin_demo_exchange_sessions s
         JOIN public.admin_demo_identities i
           ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
        WHERE s.id = $1::BIGINT AND s.admin_user_id = $2 AND s.admin_scope = 'ADMIN'
          AND s.provider = $3::public.admin_demo_provider AND s.environment = $4
          AND i.is_active
        LIMIT 1`,
      [sessionId, adminUserId, provider, environment],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  return {
    async listCredentialStatuses(adminUserId) {
      assertAdmin(adminUserId);
      const result = await query<CredentialRow & Record<string, unknown>>(
        `SELECT DISTINCT ON (provider) provider, environment,
                owner_confirmed_at, is_enabled, created_at, updated_at, revoked_at
           FROM public.admin_demo_exchange_credentials
          WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
          ORDER BY provider, created_at DESC`,
        [adminUserId],
      );
      const rows = new Map(result.rows.map((row) => [row.provider, row]));
      return ADMIN_DEMO_PROVIDERS.map((provider) => {
        const environment = ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];
        const row = rows.get(provider);
        return mapCredentialStatus(
          provider,
          environment,
          row && row.environment === environment ? row : undefined,
        );
      });
    },

    getCredentialStatus,

    async getCredential(adminUserId, provider): Promise<AdminDemoProviderCredential | null> {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      const result = await query<CredentialRow & Record<string, unknown>>(
        `SELECT c.id::TEXT, c.admin_user_id, c.provider, c.environment,
                c.api_key_ciphertext, c.secret_key_ciphertext, c.passphrase_ciphertext,
                c.owner_confirmed_at, c.is_enabled, c.created_at, c.updated_at, c.revoked_at
           FROM public.admin_demo_exchange_credentials c
           JOIN public.admin_demo_identities i
             ON i.admin_user_id = c.admin_user_id AND i.admin_scope = c.admin_scope
          WHERE c.admin_user_id = $1 AND c.admin_scope = 'ADMIN'
            AND c.provider = $2::public.admin_demo_provider AND c.environment = $3
            AND c.owner_confirmed_at IS NOT NULL AND c.revoked_at IS NULL AND i.is_active
          ORDER BY c.created_at DESC LIMIT 1`,
        [adminUserId, provider, environment],
      );
      const row = result.rows[0];
      if (!row) return null;
      try {
        return {
          id: row.id,
          adminUserId: row.admin_user_id,
          provider: row.provider,
          environment: row.environment,
          apiKey: decryptCredential(row.api_key_ciphertext),
          apiSecret: decryptCredential(row.secret_key_ciphertext),
          ...(row.passphrase_ciphertext === null
            ? {}
            : { passphrase: decryptCredential(row.passphrase_ciphertext) }),
          ownerConfirmedAt: row.owner_confirmed_at,
          enabled: row.is_enabled,
          revokedAt: row.revoked_at,
        };
      } catch {
        throw new Error('Stored Admin Demo credentials could not be decrypted.');
      }
    },

    async saveCredential(
      adminUserId: number,
      provider: AdminDemoProvider,
      credential: AdminDemoProviderCredentialInput,
    ): Promise<AdminDemoProviderCredentialStatus> {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      if (credential.ownerConfirmed !== true ||
          typeof credential.apiKey !== 'string' || typeof credential.apiSecret !== 'string' ||
          !credential.apiKey.trim() || !credential.apiSecret.trim() ||
          credential.apiKey.trim().length > 512 || credential.apiSecret.trim().length > 512 ||
          (credential.passphrase !== undefined &&
            (typeof credential.passphrase !== 'string' || credential.passphrase.trim().length > 512))) {
        throw new Error('Admin Demo credential input is invalid.');
      }
      const apiKeyCiphertext = encryptCredential(credential.apiKey.trim());
      const secretCiphertext = encryptCredential(credential.apiSecret.trim());
      const passphraseCiphertext = credential.passphrase?.trim()
        ? encryptCredential(credential.passphrase.trim())
        : null;
      await transaction(async (tx) => {
        const identity = await tx<{ is_active: boolean } & Record<string, unknown>>(
          `SELECT is_active FROM public.admin_demo_identities
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN' FOR UPDATE`,
          [adminUserId],
        );
        if (!identity.rows[0]?.is_active) {
          throw new Error('Admin Demo identity is unavailable or inactive.');
        }
        const activeSession = await tx<{ id: string } & Record<string, unknown>>(
          `SELECT id::TEXT FROM public.admin_demo_exchange_sessions
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND session_status IN ('CREATED', 'AUTHORIZED', 'RUNNING', 'RECONCILIATION_REQUIRED')
            LIMIT 1 FOR UPDATE`,
          [adminUserId, provider, environment],
        );
        if (activeSession.rows[0]) {
          throw new Error('Admin Demo credentials cannot be rotated while a session is active.');
        }
        await tx(
          `UPDATE public.admin_demo_exchange_credentials
              SET is_enabled = FALSE, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND revoked_at IS NULL`,
          [adminUserId, provider, environment],
        );
        await tx(
          `INSERT INTO public.admin_demo_exchange_credentials (
             admin_user_id, admin_scope, provider, environment,
             api_key_ciphertext, secret_key_ciphertext, passphrase_ciphertext,
             owner_confirmed_at, is_enabled
           )
           VALUES ($1, 'ADMIN', $2::public.admin_demo_provider, $3, $4, $5, $6, CURRENT_TIMESTAMP, FALSE)`,
          [adminUserId, provider, environment, apiKeyCiphertext, secretCiphertext, passphraseCiphertext],
        );
        await appendAuditWith(tx, {
          adminUserId, provider, environment, eventType: 'CREDENTIAL_SAVED',
          eventStatus: 'SUCCEEDED',
          safeDetails: { environment },
        });
      }, 'Admin Demo credential rotation conflicted with another request.');
      return getCredentialStatus(adminUserId, provider);
    },

    async revokeCredential(adminUserId, provider) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      return transaction(async (tx) => {
        const result = await tx<{ id: string } & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_credentials
              SET is_enabled = FALSE, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND revoked_at IS NULL
          RETURNING id::TEXT`,
          [adminUserId, provider, environment],
        );
        if (!result.rows[0]) return false;
        await tx(
          `UPDATE public.admin_demo_exchange_authorizations
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND revoked_at IS NULL
              AND session_id IN (
                SELECT id FROM public.admin_demo_exchange_sessions
                 WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
                   AND provider = $2::public.admin_demo_provider AND environment = $3
              )`,
          [adminUserId, provider, environment],
        );
        await tx(
          `UPDATE public.admin_demo_exchange_sessions
              SET session_status = CASE
                    WHEN session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
                      THEN 'RECONCILIATION_REQUIRED'
                    ELSE 'REVOKED'
                  END,
                  is_enabled = FALSE,
                  ended_at = CASE WHEN session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
                    THEN ended_at ELSE CURRENT_TIMESTAMP END
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND credential_id = $4::BIGINT
              AND session_status IN ('CREATED', 'AUTHORIZED', 'RUNNING', 'RECONCILIATION_REQUIRED')`,
          [adminUserId, provider, environment, result.rows[0].id],
        );
        await tx(
          `UPDATE public.admin_demo_exchange_executions
              SET execution_status = 'RECONCILIATION_REQUIRED', updated_at = CURRENT_TIMESTAMP
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND session_id IN (
                SELECT id FROM public.admin_demo_exchange_sessions
                 WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
                   AND provider = $2::public.admin_demo_provider AND environment = $3
                   AND credential_id = $4::BIGINT
              )
              AND execution_status NOT IN ('CLOSED', 'FAILED', 'REVOKED')`,
          [adminUserId, provider, environment, result.rows[0].id],
        );
        await appendAuditWith(tx, {
          adminUserId, provider, environment, eventType: 'CREDENTIAL_REVOKED',
          eventStatus: 'SUCCEEDED',
          safeDetails: { environment },
        });
        return true;
      });
    },

    async listSessions(adminUserId, provider, limit) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertLimit(limit);
      const result = await query<SessionRow & Record<string, unknown>>(
        `SELECT s.id::TEXT, s.admin_user_id, s.provider, s.environment,
                s.credential_id::TEXT, s.session_status, s.symbol, s.direction,
                s.created_at, s.started_at, s.ended_at
           FROM public.admin_demo_exchange_sessions s
           JOIN public.admin_demo_identities i
             ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
          WHERE s.admin_user_id = $1 AND s.admin_scope = 'ADMIN'
            AND s.provider = $2::public.admin_demo_provider AND s.environment = $3
            AND i.is_active
          ORDER BY s.created_at DESC, s.id DESC LIMIT $4`,
        [adminUserId, provider, environment, limit],
      );
      return result.rows.map(mapSession);
    },

    async createSession(
      adminUserId: number,
      provider: AdminDemoProvider,
      input: AdminDemoProviderSessionInput,
    ) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      if ((input.symbol === undefined) !== (input.direction === undefined) ||
          (input.symbol !== undefined && !symbolPattern.test(input.symbol)) ||
          (input.direction !== undefined && !['LONG', 'SHORT'].includes(input.direction))) {
        throw new Error('Admin Demo session input is invalid.');
      }
      return transaction(async (tx) => {
        const identity = await tx<{ id: string; is_active: boolean } & Record<string, unknown>>(
          `SELECT admin_user_id::TEXT AS id, is_active FROM public.admin_demo_identities
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN' FOR UPDATE`,
          [adminUserId],
        );
        if (!identity.rows[0]?.is_active) {
          throw new Error('Admin Demo identity is unavailable or inactive.');
        }
        const credential = await tx<{ id: string } & Record<string, unknown>>(
          `SELECT id::TEXT FROM public.admin_demo_exchange_credentials
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND is_enabled AND revoked_at IS NULL
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [adminUserId, provider, environment],
        );
        if (!credential.rows[0]) throw new Error('An enabled Admin Demo credential is required.');
        const existing = await tx<SessionRow & Record<string, unknown>>(
          `SELECT id::TEXT, admin_user_id, provider, environment, credential_id::TEXT,
                  session_status, symbol, direction, created_at, started_at, ended_at
             FROM public.admin_demo_exchange_sessions
            WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
              AND provider = $2::public.admin_demo_provider AND environment = $3
              AND credential_id = $4::BIGINT
              AND session_status IN ('CREATED', 'AUTHORIZED', 'RUNNING', 'RECONCILIATION_REQUIRED')
            LIMIT 1 FOR UPDATE`,
          [adminUserId, provider, environment, credential.rows[0].id],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].symbol === (input.symbol ?? null) &&
              existing.rows[0].direction === (input.direction ?? null)) {
            return mapSession(existing.rows[0]);
          }
          throw new Error('An active Admin Demo session already exists for this credential.');
        }
        const inserted = await tx<SessionRow & Record<string, unknown>>(
          `INSERT INTO public.admin_demo_exchange_sessions (
             admin_user_id, admin_scope, provider, environment, credential_id,
             session_status, symbol, direction, is_enabled, execution_mode
           )
           VALUES ($1, 'ADMIN', $2::public.admin_demo_provider, $3, $4::BIGINT,
                   'CREATED', $5, $6, TRUE, 'CONFIRM')
           RETURNING id::TEXT, admin_user_id, provider, environment, credential_id::TEXT,
                     session_status, symbol, direction, created_at, started_at, ended_at`,
          [
            adminUserId, provider, environment, credential.rows[0].id,
            input.symbol ?? null, input.direction ?? null,
          ],
        );
        if (!inserted.rows[0]) throw new Error('Admin Demo session could not be created.');
        return mapSession(inserted.rows[0]);
      }, 'An active Admin Demo session already exists for this credential.');
    },

    getSession,

    async createAuthorization(adminUserId, provider, sessionId, expiresInSeconds, permittedActions) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertExpiry(expiresInSeconds);
      const normalizedActions = [...new Set(permittedActions)];
      if (normalizedActions.length === 0 || normalizedActions.some((action) => !actions.has(action))) {
        throw new Error('Admin Demo authorization actions are invalid.');
      }
      return transaction(async (tx) => {
        const session = await tx<SessionRow & Record<string, unknown>>(
          `SELECT s.id::TEXT, s.admin_user_id, s.provider, s.environment,
                  s.credential_id::TEXT, s.session_status, s.symbol, s.direction,
                  s.created_at, s.started_at, s.ended_at
             FROM public.admin_demo_exchange_sessions s
             JOIN public.admin_demo_identities i
               ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
             JOIN public.admin_demo_exchange_credentials c
               ON c.id = s.credential_id AND c.admin_user_id = s.admin_user_id
              AND c.admin_scope = s.admin_scope AND c.provider = s.provider
              AND c.environment = s.environment
            WHERE s.id = $1::BIGINT AND s.admin_user_id = $2 AND s.admin_scope = 'ADMIN'
              AND s.provider = $3::public.admin_demo_provider AND s.environment = $4
              AND s.session_status IN ('CREATED', 'AUTHORIZED') AND s.is_enabled
              AND c.is_enabled AND c.revoked_at IS NULL AND i.is_active
            FOR UPDATE OF s`,
          [sessionId, adminUserId, provider, environment],
        );
        if (!session.rows[0]) throw new Error('Admin Demo session is unavailable for authorization.');
        const existing = await tx<AuthorizationRow & Record<string, unknown>>(
          `SELECT id::TEXT, session_id::TEXT,
                  admin_user_id, provider, environment,
                  permitted_actions, expires_at, consumed_at, revoked_at
             FROM public.admin_demo_exchange_authorizations
            WHERE session_id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
            LIMIT 1 FOR UPDATE`,
          [sessionId, adminUserId, provider, environment],
        );
        if (existing.rows[0]) {
          const currentActions = [...existing.rows[0].permitted_actions].sort();
          if (JSON.stringify(currentActions) === JSON.stringify([...normalizedActions].sort())) {
            return mapAuthorization(existing.rows[0]);
          }
          throw new Error('An active Admin Demo authorization already exists for this session.');
        }
        await tx(
          `UPDATE public.admin_demo_exchange_authorizations
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE session_id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP`,
          [sessionId, adminUserId, provider, environment],
        );
        const inserted = await tx<AuthorizationRow & Record<string, unknown>>(
          `INSERT INTO public.admin_demo_exchange_authorizations (
             session_id, admin_user_id, admin_scope, provider, environment,
             permitted_actions, expires_at
           )
           VALUES ($1::BIGINT, $2, 'ADMIN', $3::public.admin_demo_provider, $4,
                   $5::TEXT[], CURRENT_TIMESTAMP + ($6 * INTERVAL '1 second'))
           RETURNING id::TEXT, session_id::TEXT, admin_user_id, provider, environment,
                     permitted_actions, expires_at, consumed_at, revoked_at`,
          [sessionId, adminUserId, provider, environment, normalizedActions, expiresInSeconds],
        );
        if (!inserted.rows[0]) throw new Error('Admin Demo authorization could not be created.');
        await tx(
          `UPDATE public.admin_demo_exchange_sessions SET session_status = 'AUTHORIZED'
            WHERE id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND session_status = 'CREATED'`,
          [sessionId, adminUserId, provider, environment],
        );
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId, authorizationId: inserted.rows[0].id,
          eventType: 'AUTHORIZATION_CREATED', eventStatus: 'SUCCEEDED',
          safeDetails: { permittedActions: normalizedActions, environment },
        });
        return mapAuthorization(inserted.rows[0]);
      }, 'An active Admin Demo authorization already exists for this session.');
    },

    async renewReconciliationAuthorization(
      adminUserId,
      provider,
      sessionId,
      authorizationId,
      expiresInSeconds,
    ) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertId(authorizationId, 'authorization');
      assertExpiry(expiresInSeconds);
      return transaction(async (tx) => {
        const session = await tx<SessionRow & Record<string, unknown>>(
          `SELECT s.id::TEXT, s.admin_user_id, s.provider, s.environment,
                  s.credential_id::TEXT, s.session_status, s.symbol, s.direction,
                  s.created_at, s.started_at, s.ended_at
             FROM public.admin_demo_exchange_sessions s
             JOIN public.admin_demo_identities i
               ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
             JOIN public.admin_demo_exchange_credentials c
               ON c.id = s.credential_id AND c.admin_user_id = s.admin_user_id
              AND c.admin_scope = s.admin_scope AND c.provider = s.provider
              AND c.environment = s.environment
            WHERE s.id = $1::BIGINT AND s.admin_user_id = $2 AND s.admin_scope = 'ADMIN'
              AND s.provider = $3::public.admin_demo_provider AND s.environment = $4
              AND s.session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
              AND i.is_active AND c.is_enabled AND c.revoked_at IS NULL
            FOR UPDATE OF s`,
          [sessionId, adminUserId, provider, environment],
        );
        if (!session.rows[0]) {
          throw new Error('Only an active Admin Demo session can renew reconciliation authorization.');
        }
        const oldAuthorization = await tx<AuthorizationRow & Record<string, unknown>>(
          `SELECT id::TEXT, session_id::TEXT,
                  admin_user_id, provider, environment,
                  permitted_actions, expires_at, consumed_at, revoked_at
             FROM public.admin_demo_exchange_authorizations
            WHERE id = $1::BIGINT AND session_id = $2::BIGINT AND admin_user_id = $3
              AND admin_scope = 'ADMIN' AND provider = $4::public.admin_demo_provider
              AND environment = $5 AND revoked_at IS NULL
              AND consumed_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
              AND 'RECONCILE' = ANY(permitted_actions)
            FOR UPDATE`,
          [authorizationId, sessionId, adminUserId, provider, environment],
        );
        if (!oldAuthorization.rows[0]) {
          throw new Error('Only a consumed, expired reconciliation authorization can be renewed.');
        }
        const execution = await tx<{ id: string; execution_status: string } & Record<string, unknown>>(
          `SELECT e.id::TEXT, e.execution_status
             FROM public.admin_demo_exchange_executions e
             JOIN public.admin_demo_exchange_sessions s
               ON s.id = e.session_id AND s.admin_user_id = e.admin_user_id
              AND s.admin_scope = e.admin_scope AND s.provider = e.provider
              AND s.environment = e.environment
            WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
              AND e.provider = $3::public.admin_demo_provider AND e.environment = $4
              AND e.authorization_id = $5::BIGINT
              AND s.session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
              AND e.execution_status IN (
                'CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED',
                'RECONCILIATION_REQUIRED'
              )
            FOR UPDATE OF e`,
          [sessionId, adminUserId, provider, environment, authorizationId],
        );
        if (!execution.rows[0]) {
          throw new Error('A recoverable active execution is required to renew reconciliation authorization.');
        }
        await tx(
          `UPDATE public.admin_demo_exchange_authorizations
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE session_id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP`,
          [sessionId, adminUserId, provider, environment],
        );
        const inserted = await tx<AuthorizationRow & Record<string, unknown>>(
          `INSERT INTO public.admin_demo_exchange_authorizations (
             session_id, admin_user_id, admin_scope, provider, environment,
             permitted_actions, expires_at, consumed_at
           )
           VALUES ($1::BIGINT, $2, 'ADMIN', $3::public.admin_demo_provider, $4,
                   ARRAY['RECONCILE']::TEXT[],
                   CURRENT_TIMESTAMP + ($5 * INTERVAL '1 second'), CURRENT_TIMESTAMP)
           RETURNING id::TEXT, session_id::TEXT, admin_user_id, provider, environment,
                     permitted_actions, expires_at, consumed_at, revoked_at`,
          [sessionId, adminUserId, provider, environment, expiresInSeconds],
        );
        if (!inserted.rows[0]) throw new Error('Admin Demo recovery authorization could not be created.');
        const rebound = await tx(
          `UPDATE public.admin_demo_exchange_executions
              SET authorization_id = $1::BIGINT, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = $2::BIGINT AND admin_user_id = $3 AND admin_scope = 'ADMIN'
              AND provider = $4::public.admin_demo_provider AND environment = $5
              AND authorization_id = $6::BIGINT
              AND execution_status IN (
                'CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED',
                'RECONCILIATION_REQUIRED'
              )
          RETURNING id`,
          [inserted.rows[0].id, sessionId, adminUserId, provider, environment, authorizationId],
        );
        if (!rebound.rows[0]) throw new Error('Admin Demo execution changed during authorization renewal.');
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId, authorizationId,
          eventType: 'AUTHORIZATION_REVOKED', eventStatus: 'SUCCEEDED',
          safeDetails: { action: 'RECONCILE', environment },
        });
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId, authorizationId: inserted.rows[0].id,
          eventType: 'AUTHORIZATION_CREATED', eventStatus: 'SUCCEEDED',
          safeDetails: { permittedActions: ['RECONCILE'], environment },
        });
        return mapAuthorization(inserted.rows[0]);
      }, 'An active Admin Demo reconciliation authorization already exists.');
    },

    async revokeAuthorization(adminUserId, provider, sessionId, authorizationId) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertId(authorizationId, 'authorization');
      return transaction(async (tx) => {
        const result = await tx<{ id: string } & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_authorizations
              SET revoked_at = CURRENT_TIMESTAMP
            WHERE id = $1::BIGINT AND session_id = $2::BIGINT AND admin_user_id = $3
              AND admin_scope = 'ADMIN' AND provider = $4::public.admin_demo_provider
              AND environment = $5 AND revoked_at IS NULL
          RETURNING id::TEXT`,
          [authorizationId, sessionId, adminUserId, provider, environment],
        );
        if (!result.rows[0]) return false;
        await tx(
          `UPDATE public.admin_demo_exchange_sessions
              SET session_status = 'CREATED'
            WHERE id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND session_status = 'AUTHORIZED' AND NOT EXISTS (
                SELECT 1 FROM public.admin_demo_exchange_executions e
                 WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2
                   AND e.admin_scope = 'ADMIN' AND e.provider = $3::public.admin_demo_provider
                   AND e.environment = $4
              )`,
          [sessionId, adminUserId, provider, environment],
        );
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId, authorizationId,
          eventType: 'AUTHORIZATION_REVOKED', eventStatus: 'SUCCEEDED',
          safeDetails: { environment },
        });
        return true;
      });
    },

    async authorizeAction(adminUserId, provider, sessionId, authorizationId, action) {
      try {
        assertAdmin(adminUserId);
        const environment = assertProvider(provider);
        assertId(sessionId, 'session');
        assertId(authorizationId, 'authorization');
        if (!actions.has(action)) return false;
        const result = await database.rpc('authorize_admin_demo_exchange_action', {
          p_admin_user_id: adminUserId,
          p_admin_scope: 'ADMIN',
          p_session_id: sessionId,
          p_authorization_id: authorizationId,
          p_provider: provider,
          p_environment: environment,
          p_action: action,
        });
        return result.error === null && result.data === true;
      } catch {
        return false;
      }
    },

    async reserveExecution(adminUserId, provider, input) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertExecutionInput(input);
      return transaction(async (tx) => {
        const session = await tx<SessionRow & Record<string, unknown>>(
          `SELECT s.id::TEXT, s.admin_user_id, s.provider, s.environment, s.credential_id::TEXT,
                  s.session_status, s.symbol, s.direction, s.created_at, s.started_at, s.ended_at
             FROM public.admin_demo_exchange_sessions s
             JOIN public.admin_demo_identities i
               ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
             JOIN public.admin_demo_exchange_credentials c
               ON c.id = s.credential_id AND c.admin_user_id = s.admin_user_id
              AND c.admin_scope = s.admin_scope AND c.provider = s.provider
              AND c.environment = s.environment
            WHERE s.id = $1::BIGINT AND s.admin_user_id = $2 AND s.admin_scope = 'ADMIN'
              AND s.provider = $3::public.admin_demo_provider AND s.environment = $4
              AND s.session_status IN ('CREATED', 'AUTHORIZED', 'RUNNING')
              AND s.is_enabled AND s.execution_mode = 'CONFIRM'
              AND i.is_active AND c.is_enabled AND c.revoked_at IS NULL
            FOR UPDATE OF s, i, c`,
          [input.sessionId, adminUserId, provider, environment],
        );
        if (!session.rows[0]) return 'BUSY';
        const existing = await tx<{
          id: string;
          authorization_id: string;
          entry_order_type: string;
          limit_entry_price: string | null;
          symbol: string;
          direction: string;
          quantity: string;
          entry_price: string;
          stop_loss: string;
          tp1_price: string;
          tp2_price: string;
          tp3_price: string;
          tick_size: string;
          entry_client_order_id: string;
          stop_client_order_id: string;
          tp3_client_order_id: string;
          trailing_client_order_id: string;
        } & Record<string, unknown>>(
          `SELECT id::TEXT, authorization_id::TEXT, entry_order_type,
                  limit_entry_price::TEXT, symbol, direction, quantity::TEXT, entry_price::TEXT,
                  stop_loss::TEXT, tp1_price::TEXT, tp2_price::TEXT, tp3_price::TEXT,
                  tick_size::TEXT, entry_client_order_id, stop_client_order_id,
                  tp3_client_order_id, trailing_client_order_id
             FROM public.admin_demo_exchange_executions
            WHERE session_id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
            LIMIT 1`,
          [input.sessionId, adminUserId, provider, environment],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          const sameRequest =
            prior.authorization_id === input.authorizationId &&
            prior.entry_order_type === input.entryOrderType &&
            sameDecimal(prior.limit_entry_price, input.limitEntryPrice) &&
            prior.symbol === input.symbol && prior.direction === input.direction &&
            sameDecimal(prior.quantity, input.quantity) && sameDecimal(prior.entry_price, input.entryPrice) &&
            sameDecimal(prior.stop_loss, input.stopLoss) && sameDecimal(prior.tp1_price, input.tp1Price) &&
            sameDecimal(prior.tp2_price, input.tp2Price) && sameDecimal(prior.tp3_price, input.tp3Price) &&
            sameDecimal(prior.tick_size, input.tickSize) &&
            prior.entry_client_order_id === input.entryClientOrderId &&
            prior.stop_client_order_id === input.stopClientOrderId &&
            prior.tp3_client_order_id === input.tp3ClientOrderId &&
            prior.trailing_client_order_id === input.trailingClientOrderId;
          if (!sameRequest) return 'BUSY';
          const retryAuthorization = await tx<{ id: string } & Record<string, unknown>>(
            `SELECT a.id::TEXT
               FROM public.admin_demo_exchange_authorizations a
               JOIN public.admin_demo_identities i
                 ON i.admin_user_id = a.admin_user_id AND i.admin_scope = a.admin_scope
               JOIN public.admin_demo_exchange_sessions s
                 ON s.id = a.session_id AND s.admin_user_id = a.admin_user_id
                AND s.admin_scope = a.admin_scope AND s.provider = a.provider
                AND s.environment = a.environment
               JOIN public.admin_demo_exchange_credentials c
                 ON c.id = s.credential_id AND c.admin_user_id = a.admin_user_id
                AND c.admin_scope = a.admin_scope
                AND c.provider = a.provider AND c.environment = a.environment
              WHERE a.id = $1::BIGINT AND a.session_id = $2::BIGINT
                AND a.admin_user_id = $3 AND a.admin_scope = 'ADMIN'
                AND a.provider = $4::public.admin_demo_provider AND a.environment = $5
                AND a.revoked_at IS NULL AND a.expires_at > CURRENT_TIMESTAMP
                AND a.consumed_at IS NOT NULL AND 'START_TEST' = ANY(a.permitted_actions)
                AND i.is_active AND c.is_enabled AND c.revoked_at IS NULL
              LIMIT 1 FOR UPDATE OF a`,
            [input.authorizationId, input.sessionId, adminUserId, provider, environment],
          );
          if (!retryAuthorization.rows[0]) return 'BUSY';
          return 'EXISTING';
        }
        if ((session.rows[0].symbol !== null && session.rows[0].symbol !== input.symbol) ||
            (session.rows[0].direction !== null && session.rows[0].direction !== input.direction)) {
          return 'BUSY';
        }
        const authorization = await tx<{ id: string } & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_authorizations a
              SET consumed_at = CURRENT_TIMESTAMP
             FROM public.admin_demo_identities i,
                  public.admin_demo_exchange_sessions s,
                  public.admin_demo_exchange_credentials c
            WHERE a.id = $1::BIGINT AND a.session_id = $2::BIGINT
              AND a.admin_user_id = $3 AND a.admin_scope = 'ADMIN'
              AND a.provider = $4::public.admin_demo_provider AND a.environment = $5
              AND a.revoked_at IS NULL AND a.expires_at > CURRENT_TIMESTAMP
              AND a.consumed_at IS NULL AND 'START_TEST' = ANY(a.permitted_actions)
              AND i.admin_user_id = a.admin_user_id AND i.admin_scope = a.admin_scope
              AND i.is_active
              AND s.id = a.session_id AND s.admin_user_id = a.admin_user_id
              AND s.admin_scope = a.admin_scope AND s.provider = a.provider
              AND s.environment = a.environment AND s.credential_id = c.id
              AND s.is_enabled AND s.execution_mode = 'CONFIRM'
              AND c.admin_user_id = a.admin_user_id AND c.admin_scope = a.admin_scope
              AND c.provider = a.provider AND c.environment = a.environment
              AND c.is_enabled AND c.revoked_at IS NULL
          RETURNING a.id::TEXT`,
          [input.authorizationId, input.sessionId, adminUserId, provider, environment],
        );
        if (!authorization.rows[0]) return 'BUSY';
        const inserted = await tx<{ id: string } & Record<string, unknown>>(
          `INSERT INTO public.admin_demo_exchange_executions (
             session_id, authorization_id, admin_user_id, admin_scope, provider, environment,
             entry_order_type, limit_entry_price, symbol, direction, quantity, entry_price,
             entry_client_order_id, stop_loss, tp1_price, tp2_price, tp3_price, tick_size,
             stop_client_order_id, tp3_client_order_id, trailing_client_order_id,
             execution_status, protection_status, is_enabled, execution_mode
           )
           VALUES (
             $1::BIGINT, $2::BIGINT, $3, 'ADMIN', $4::public.admin_demo_provider, $5,
             $6, $7::NUMERIC, $8, $9, $10::NUMERIC, $11::NUMERIC,
             $12, $13::NUMERIC, $14::NUMERIC, $15::NUMERIC, $16::NUMERIC, $17::NUMERIC,
             $18, $19, $20, 'CREATED', 'PENDING', TRUE, 'CONFIRM'
           )
           RETURNING id::TEXT`,
          [
            input.sessionId, input.authorizationId, adminUserId, provider, environment,
            input.entryOrderType, input.limitEntryPrice, input.symbol, input.direction,
            input.quantity, input.entryPrice, input.entryClientOrderId, input.stopLoss,
            input.tp1Price, input.tp2Price, input.tp3Price, input.tickSize,
            input.stopClientOrderId, input.tp3ClientOrderId, input.trailingClientOrderId,
          ],
        );
        if (!inserted.rows[0]) {
          throw new Error('Admin Demo execution reservation could not be persisted.');
        }
        await tx(
          `UPDATE public.admin_demo_exchange_sessions
              SET session_status = 'RUNNING', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
            WHERE id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $3::public.admin_demo_provider AND environment = $4
              AND session_status IN ('CREATED', 'AUTHORIZED', 'RUNNING')`,
          [input.sessionId, adminUserId, provider, environment],
        );
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId: input.sessionId,
          authorizationId: input.authorizationId,
          eventType: 'TEST_STARTED', eventStatus: 'SUCCEEDED',
          safeDetails: { environment, direction: input.direction },
        });
        return 'CREATED';
      }, 'BUSY');
    },

    async getExecution(adminUserId, provider, sessionId) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      const result = await query<ExecutionRow & Record<string, unknown>>(
        `SELECT e.id::TEXT, e.session_id::TEXT, e.authorization_id::TEXT,
                e.admin_user_id, e.provider, e.environment, e.symbol, e.direction,
                e.entry_order_type, e.execution_status, e.protection_status,
                e.entry_client_order_id, e.entry_exchange_order_id,
                e.quantity::TEXT, e.entry_price::TEXT, e.stop_loss::TEXT,
                e.tp1_price::TEXT, e.tp2_price::TEXT, e.tp3_price::TEXT, e.tick_size::TEXT,
                e.stop_client_order_id, e.tp3_client_order_id, e.trailing_client_order_id,
                e.stop_protection_id, e.tp3_protection_id, e.trailing_protection_id,
                e.tp1_reached_at, e.tp2_reached_at, e.execution_mode,
                e.created_at, e.updated_at, e.closed_at
           FROM public.admin_demo_exchange_executions e
           JOIN public.admin_demo_identities i
             ON i.admin_user_id = e.admin_user_id AND i.admin_scope = e.admin_scope
          WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
            AND e.provider = $3::public.admin_demo_provider AND e.environment = $4
            AND i.is_active`,
        [sessionId, adminUserId, provider, environment],
      );
      return result.rows[0] ? mapDetailedExecution(result.rows[0]) : null;
    },

    async updateExecutionProgress(adminUserId, provider, sessionId, update, authorizationId, reconciliationLockToken) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertId(authorizationId, 'authorization');
      if (
        (reconciliationLockToken !== undefined && !/^[0-9a-f-]{36}$/i.test(reconciliationLockToken)) ||
        (update.executionStatus !== undefined && !executionStatuses.has(update.executionStatus)) ||
        (update.protectionStatus !== undefined && !protectionStatuses.has(update.protectionStatus)) ||
        (update.filledQuantity !== undefined && !decimalIsPositive(update.filledQuantity)) ||
        [update.entryExchangeOrderId, update.stopProtectionId, update.tp3ProtectionId,
        update.trailingProtectionId].some((value) =>
        value !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(value))
      ) {
        throw new Error('Admin Demo execution progress is invalid.');
      }
      const details: Record<string, unknown> = {
        environment,
        ...(update.executionStatus ? { executionStatus: update.executionStatus } : {}),
        ...(update.protectionStatus ? { protectionStatus: update.protectionStatus } : {}),
      };
      return transaction(async (tx) => {
        const result = await tx<ExecutionRow & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_executions e
              SET execution_status = COALESCE($4, e.execution_status),
                  protection_status = COALESCE($5, e.protection_status),
                  entry_exchange_order_id = COALESCE($6, e.entry_exchange_order_id),
                  stop_protection_id = COALESCE($7, e.stop_protection_id),
                  tp3_protection_id = COALESCE($8, e.tp3_protection_id),
                  trailing_protection_id = COALESCE($9, e.trailing_protection_id),
                  quantity = COALESCE($14::NUMERIC, e.quantity),
                  tp1_reached_at = CASE WHEN $10::BOOLEAN
                    THEN COALESCE(e.tp1_reached_at, CURRENT_TIMESTAMP) ELSE e.tp1_reached_at END,
                  tp2_reached_at = CASE WHEN $11::BOOLEAN
                    THEN COALESCE(e.tp2_reached_at, CURRENT_TIMESTAMP) ELSE e.tp2_reached_at END,
                  updated_at = CURRENT_TIMESTAMP,
                  closed_at = CASE WHEN COALESCE($4, e.execution_status) IN ('CLOSED', 'FAILED', 'REVOKED')
                    THEN COALESCE(e.closed_at, CURRENT_TIMESTAMP) ELSE e.closed_at END
             FROM public.admin_demo_exchange_sessions s
             JOIN public.admin_demo_identities i
               ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
            WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
              AND e.provider = $3::public.admin_demo_provider AND e.environment = $12
              AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
              AND s.admin_scope = e.admin_scope AND s.provider = e.provider
              AND s.environment = e.environment AND i.is_active
              AND s.is_enabled AND s.execution_mode = 'CONFIRM'
              AND e.authorization_id = $13::BIGINT
              AND ($15::UUID IS NULL OR (e.reconcile_lock_token = $15::UUID
                AND e.reconcile_lock_until > CURRENT_TIMESTAMP))
          RETURNING e.id::TEXT, e.session_id::TEXT, e.authorization_id::TEXT,
                    e.admin_user_id, e.provider, e.environment, e.symbol, e.direction,
                    e.entry_order_type, e.execution_status, e.protection_status,
                    e.entry_client_order_id, e.entry_exchange_order_id,
                    e.quantity::TEXT, e.entry_price::TEXT, e.stop_loss::TEXT,
                    e.tp1_price::TEXT, e.tp2_price::TEXT, e.tp3_price::TEXT, e.tick_size::TEXT,
                    e.stop_client_order_id, e.tp3_client_order_id, e.trailing_client_order_id,
                    e.stop_protection_id, e.tp3_protection_id, e.trailing_protection_id,
                    e.tp1_reached_at, e.tp2_reached_at, e.execution_mode,
                    e.created_at, e.updated_at, e.closed_at`,
          [
            sessionId, adminUserId, provider, update.executionStatus ?? null,
            update.protectionStatus ?? null, update.entryExchangeOrderId ?? null,
            update.stopProtectionId ?? null, update.tp3ProtectionId ?? null,
            update.trailingProtectionId ?? null, update.tp1Reached === true,
            update.tp2Reached === true, environment, authorizationId, update.filledQuantity ?? null,
            reconciliationLockToken ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error('Admin Demo execution is unavailable for this administrator and provider.');
        }
        await tx(
          `UPDATE public.admin_demo_exchange_sessions
              SET session_status = CASE
                    WHEN $3 = 'CLOSED' THEN 'PASSED'
                    WHEN $3 = 'FAILED' THEN 'FAILED'
                    WHEN $3 = 'REVOKED' THEN 'REVOKED'
                    WHEN $3 IN ('ENTRY_UNKNOWN', 'RECONCILIATION_REQUIRED')
                      THEN 'RECONCILIATION_REQUIRED'
                    WHEN $3 IN ('ENTRY_SUBMITTING', 'ENTRY_FILLED', 'PROTECTED')
                      THEN 'RUNNING'
                    ELSE session_status
                  END,
                  ended_at = CASE WHEN $3 IN ('CLOSED', 'FAILED', 'REVOKED')
                    THEN COALESCE(ended_at, CURRENT_TIMESTAMP) ELSE ended_at END
            WHERE id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $4::public.admin_demo_provider AND environment = $5`,
          [sessionId, adminUserId, update.executionStatus ?? row.execution_status, provider, environment],
        );
        if (update.tp1Reached) details.milestone = 'TP1';
        if (update.tp2Reached) details.milestone = 'TP2';
        const status = update.executionStatus;
        const eventType = update.protectionStatus === 'FAILED' ? 'RECONCILIATION_REQUIRED'
          : status === 'ENTRY_SUBMITTING' ? 'ENTRY_SUBMITTED'
          : status === 'ENTRY_UNKNOWN' || status === 'ENTRY_FILLED' ? 'ENTRY_RECONCILED'
              : status === 'PROTECTED' ? 'PROTECTION_VERIFIED'
                : status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED'
                  : status === 'CLOSED' ? 'POSITION_CLOSED'
                    : status === 'FAILED' || status === 'REVOKED' ? 'TEST_FAILED'
                        : update.tp1Reached || update.tp2Reached ? 'PROTECTION_VERIFIED'
                          : 'ENTRY_RECONCILED';
        const eventStatus = update.protectionStatus === 'FAILED' || status === 'ENTRY_UNKNOWN' ||
          status === 'RECONCILIATION_REQUIRED'
          ? 'UNCERTAIN'
          : status === 'FAILED' ? 'FAILED'
            : status === 'REVOKED' ? 'BLOCKED' : 'SUCCEEDED';
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId,
          authorizationId,
          eventType, eventStatus, safeDetails: details,
        });
        return mapDetailedExecution(row);
      });
    },

    async claimReconciliation(
      adminUserId,
      provider,
      sessionId,
      authorizationId,
      lockToken,
      leaseSeconds,
    ) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertId(authorizationId, 'authorization');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lockToken) ||
          !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
        throw new Error('Admin Demo reconciliation lock request is invalid.');
      }
      return transaction(async (tx) => {
        const claimed = await tx<{ id: string } & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_executions e
              SET reconcile_lock_token = $5::UUID,
                  reconcile_lock_until = CURRENT_TIMESTAMP + ($6 * INTERVAL '1 second'),
                  updated_at = CURRENT_TIMESTAMP
             FROM public.admin_demo_exchange_sessions s,
                  public.admin_demo_identities i,
                  public.admin_demo_exchange_credentials c,
                  public.admin_demo_exchange_authorizations a
            WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
              AND e.provider = $3::public.admin_demo_provider AND e.environment = $4
              AND e.authorization_id = $7::BIGINT
              AND e.execution_status IN (
                'CREATED', 'ENTRY_SUBMITTING', 'ENTRY_UNKNOWN', 'ENTRY_FILLED', 'PROTECTED',
                'RECONCILIATION_REQUIRED'
              )
              AND (e.reconcile_lock_until IS NULL OR e.reconcile_lock_until <= CURRENT_TIMESTAMP)
              AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
              AND s.admin_scope = e.admin_scope AND s.provider = e.provider
              AND s.environment = e.environment
              AND s.session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
              AND s.is_enabled AND s.execution_mode = 'CONFIRM'
              AND i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
              AND c.id = s.credential_id AND c.admin_user_id = s.admin_user_id
              AND c.admin_scope = s.admin_scope AND c.provider = s.provider
              AND c.environment = s.environment
              AND a.id = e.authorization_id AND a.session_id = e.session_id
              AND a.admin_user_id = e.admin_user_id AND a.admin_scope = e.admin_scope
              AND a.provider = e.provider AND a.environment = e.environment
              AND i.is_active AND c.is_enabled AND c.revoked_at IS NULL
              AND a.id = $7::BIGINT AND a.revoked_at IS NULL
              AND a.expires_at > CURRENT_TIMESTAMP AND a.consumed_at IS NOT NULL
              AND 'RECONCILE' = ANY(a.permitted_actions)
          RETURNING e.id::TEXT`,
          [sessionId, adminUserId, provider, environment, lockToken, leaseSeconds, authorizationId],
        );
        if (!claimed.rows[0]) return false;
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId, authorizationId,
          eventType: 'RECONCILIATION_STARTED', eventStatus: 'SUCCEEDED',
          safeDetails: { action: 'RECONCILE', environment },
        });
        return true;
      });
    },

    async verifyReconciliationLease(adminUserId, provider, sessionId, authorizationId, lockToken, minimumValiditySeconds = 0) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      assertId(authorizationId, 'authorization');
      if (!/^[0-9a-f-]{36}$/i.test(lockToken)) return false;
      if (!Number.isInteger(minimumValiditySeconds) || minimumValiditySeconds < 0 || minimumValiditySeconds > 30) return false;
      const result = await query<{ id: string } & Record<string, unknown>>(
        `SELECT e.id::TEXT FROM public.admin_demo_exchange_executions e
          WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
            AND e.provider = $3::public.admin_demo_provider AND e.environment = $4
            AND e.authorization_id = $5::BIGINT AND e.reconcile_lock_token = $6::UUID
            AND e.reconcile_lock_until > CURRENT_TIMESTAMP + ($7 * INTERVAL '1 second')
            AND EXISTS (
              SELECT 1 FROM public.admin_demo_exchange_sessions s
              JOIN public.admin_demo_identities i
                ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
              JOIN public.admin_demo_exchange_credentials c
                ON c.id = s.credential_id AND c.admin_user_id = s.admin_user_id
               AND c.admin_scope = s.admin_scope AND c.provider = s.provider
               AND c.environment = s.environment
               WHERE s.id = e.session_id AND s.admin_user_id = e.admin_user_id
                 AND s.admin_scope = e.admin_scope AND s.provider = e.provider
                 AND s.environment = e.environment AND i.is_active
                 AND s.is_enabled AND s.execution_mode = 'CONFIRM'
                 AND s.session_status IN ('RUNNING', 'RECONCILIATION_REQUIRED')
                 AND c.is_enabled AND c.revoked_at IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM public.admin_demo_exchange_authorizations a
               WHERE a.id = e.authorization_id AND a.session_id = e.session_id
                 AND a.admin_user_id = e.admin_user_id AND a.admin_scope = e.admin_scope
                 AND a.provider = e.provider AND a.environment = e.environment
                 AND a.revoked_at IS NULL AND a.consumed_at IS NOT NULL
                 AND 'RECONCILE' = ANY(a.permitted_actions)
                 AND a.expires_at > CURRENT_TIMESTAMP + ($7 * INTERVAL '1 second')
            )`,
        [sessionId, adminUserId, provider, environment, authorizationId, lockToken, minimumValiditySeconds],
      );
      return result.rows.length === 1;
    },

    async releaseReconciliation(adminUserId, provider, sessionId, lockToken) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lockToken)) {
        throw new Error('Admin Demo reconciliation lock token is invalid.');
      }
      const released = await query<{ id: string } & Record<string, unknown>>(
        `UPDATE public.admin_demo_exchange_executions
            SET reconcile_lock_token = NULL, reconcile_lock_until = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE session_id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
            AND provider = $3::public.admin_demo_provider AND environment = $4
            AND reconcile_lock_token = $5::UUID
            AND EXISTS (
              SELECT 1 FROM public.admin_demo_identities i
               WHERE i.admin_user_id = $2 AND i.admin_scope = 'ADMIN' AND i.is_active
            )
        RETURNING id::TEXT`,
        [sessionId, adminUserId, provider, environment, lockToken],
      );
      return released.rows.length > 0;
    },

    async updateExecutionStatus(
      adminUserId,
      provider,
      sessionId,
      status: AdminDemoProviderExecutionStatus,
      protectionStatus?: AdminDemoProviderProtectionStatus,
    ) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertId(sessionId, 'session');
      if (!executionStatuses.has(status) ||
          (protectionStatus !== undefined && !protectionStatuses.has(protectionStatus))) {
        throw new Error('Admin Demo execution status is invalid.');
      }
      return transaction(async (tx) => {
        const result = await tx<ExecutionRow & Record<string, unknown>>(
          `UPDATE public.admin_demo_exchange_executions e
              SET execution_status = $4,
                  protection_status = COALESCE($5, e.protection_status),
                  updated_at = CURRENT_TIMESTAMP,
                  closed_at = CASE WHEN $4 IN ('CLOSED', 'FAILED', 'REVOKED')
                    THEN COALESCE(e.closed_at, CURRENT_TIMESTAMP) ELSE e.closed_at END
             FROM public.admin_demo_exchange_sessions s
             JOIN public.admin_demo_identities i
               ON i.admin_user_id = s.admin_user_id AND i.admin_scope = s.admin_scope
            WHERE e.session_id = $1::BIGINT AND e.admin_user_id = $2 AND e.admin_scope = 'ADMIN'
              AND e.provider = $3::public.admin_demo_provider AND e.environment = $6
              AND s.id = e.session_id AND s.admin_user_id = e.admin_user_id
              AND s.admin_scope = e.admin_scope AND s.provider = e.provider
              AND s.environment = e.environment AND i.is_active
          RETURNING e.id::TEXT, e.session_id::TEXT, e.authorization_id::TEXT,
                    e.admin_user_id, e.provider,
                    e.environment, e.symbol, e.direction, e.entry_order_type,
                    e.execution_status, e.protection_status, e.created_at, e.updated_at, e.closed_at`,
          [sessionId, adminUserId, provider, status, protectionStatus ?? null, environment],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Admin Demo execution is unavailable for this administrator and provider.');
        await tx(
          `UPDATE public.admin_demo_exchange_sessions
              SET session_status = CASE
                    WHEN $3 IN ('CLOSED') THEN 'PASSED'
                    WHEN $3 = 'FAILED' THEN 'FAILED'
                    WHEN $3 = 'REVOKED' THEN 'REVOKED'
                    WHEN $3 IN ('ENTRY_UNKNOWN', 'RECONCILIATION_REQUIRED')
                      THEN 'RECONCILIATION_REQUIRED'
                    WHEN $3 IN ('ENTRY_SUBMITTING', 'ENTRY_FILLED', 'PROTECTED')
                      THEN 'RUNNING'
                    ELSE session_status
                  END,
                  ended_at = CASE WHEN $3 IN ('CLOSED', 'FAILED', 'REVOKED')
                    THEN COALESCE(ended_at, CURRENT_TIMESTAMP) ELSE ended_at END
            WHERE id = $1::BIGINT AND admin_user_id = $2 AND admin_scope = 'ADMIN'
              AND provider = $4::public.admin_demo_provider AND environment = $5`,
          [sessionId, adminUserId, status, provider, environment],
        );
        const eventType = protectionStatus === 'FAILED' ? 'RECONCILIATION_REQUIRED'
          : status === 'ENTRY_SUBMITTING' ? 'ENTRY_SUBMITTED'
          : status === 'ENTRY_UNKNOWN' || status === 'ENTRY_FILLED' ? 'ENTRY_RECONCILED'
              : status === 'PROTECTED' ? 'PROTECTION_VERIFIED'
                : status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED'
                  : status === 'CLOSED' ? 'POSITION_CLOSED'
                    : status === 'FAILED' || status === 'REVOKED' ? 'TEST_FAILED'
                        : 'ENTRY_RECONCILED';
        await appendAuditWith(tx, {
          adminUserId, provider, environment, sessionId,
          authorizationId: row.authorization_id,
          eventType,
          eventStatus: protectionStatus === 'FAILED' || status === 'ENTRY_UNKNOWN' ||
            status === 'RECONCILIATION_REQUIRED'
            ? 'UNCERTAIN'
            : status === 'FAILED' ? 'FAILED'
              : status === 'REVOKED' ? 'BLOCKED' : 'SUCCEEDED',
          safeDetails: {
            environment,
            executionStatus: status,
            ...(protectionStatus ? { protectionStatus } : {}),
          },
        });
        return mapExecution(row);
      });
    },

    async listExecutions(adminUserId, provider, limit) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertLimit(limit);
      const result = await query<ExecutionRow & Record<string, unknown>>(
        `SELECT e.id::TEXT, e.session_id::TEXT, e.admin_user_id, e.provider, e.environment,
                e.symbol, e.direction, e.entry_order_type, e.execution_status,
                e.protection_status, e.created_at, e.updated_at, e.closed_at
           FROM public.admin_demo_exchange_executions e
           JOIN public.admin_demo_identities i
             ON i.admin_user_id = e.admin_user_id AND i.admin_scope = e.admin_scope
          WHERE e.admin_user_id = $1 AND e.admin_scope = 'ADMIN'
            AND e.provider = $2::public.admin_demo_provider AND e.environment = $3
            AND i.is_active
          ORDER BY e.created_at DESC, e.id DESC LIMIT $4`,
        [adminUserId, provider, environment, limit],
      );
      return result.rows.map(mapExecution);
    },

    async listAuditEvents(adminUserId, provider, limit) {
      assertAdmin(adminUserId);
      const environment = assertProvider(provider);
      assertLimit(limit);
      const result = await query<AuditRow & Record<string, unknown>>(
        `SELECT id::TEXT, session_id::TEXT, authorization_id::TEXT,
                admin_user_id, provider, environment,
                event_type, event_status, safe_details, created_at
           FROM public.admin_demo_exchange_audit_events
          WHERE admin_user_id = $1 AND admin_scope = 'ADMIN'
            AND provider = $2::public.admin_demo_provider AND environment = $3
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [adminUserId, provider, environment, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        authorizationId: row.authorization_id ?? null,
        adminUserId: row.admin_user_id,
        provider: row.provider,
        environment: row.environment,
        eventType: auditEventTypes.has(row.event_type) ? row.event_type : 'EXECUTION_BLOCKED',
        eventStatus: eventStatuses.has(row.event_status) ? row.event_status : 'BLOCKED',
        safeDetails: auditDetailsFromRow(row.safe_details, environment),
        createdAt: row.created_at,
      }));
    },

    async appendAuditEvent(input) {
      assertAdmin(input.adminUserId);
      const environment = assertProvider(input.provider);
      await transaction((tx) => appendAuditWith(tx, {
        ...input,
        environment,
      }));
    },
  };
}
