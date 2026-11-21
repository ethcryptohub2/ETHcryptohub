import type { ExchangeBalance, ExchangeInstrument, ExchangePosition } from './exchanges/types';
import type {
  AdminDemoProvider,
  AdminDemoProviderCapabilities,
  AdminDemoProviderEnvironment,
} from './admin-demo-provider-contract';

export type AdminDemoProviderCredentialStatus = {
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  configured: boolean;
  ownerConfirmed: boolean;
  enabled: boolean;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AdminDemoProviderCredentialInput = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  ownerConfirmed: true;
};

export type AdminDemoProviderCredential = {
  id: string;
  adminUserId: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  ownerConfirmedAt: string | null;
  enabled: boolean;
  revokedAt: string | null;
};

export type AdminDemoProviderSessionStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'RUNNING'
  | 'RECONCILIATION_REQUIRED'
  | 'PASSED'
  | 'FAILED'
  | 'REVOKED'
  | 'EXPIRED';

export type AdminDemoProviderSession = {
  id: string;
  adminUserId: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  credentialId: string;
  status: AdminDemoProviderSessionStatus;
  symbol: string | null;
  direction: 'LONG' | 'SHORT' | null;
  executionMode: 'CONFIRM';
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type AdminDemoProviderSessionInput = {
  symbol?: string;
  direction?: 'LONG' | 'SHORT';
};

export type AdminDemoProviderAuthorization = {
  id: string;
  sessionId: string;
  adminUserId: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  permittedActions: Array<'START_TEST' | 'RECONCILE'>;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
};

export type AdminDemoProviderAuthorizationAction = 'START_TEST' | 'RECONCILE';

export type AdminDemoProviderExecutionInput = {
  sessionId: string;
  authorizationId: string;
  entryOrderType: 'MARKET' | 'LIMIT';
  limitEntryPrice: string | null;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  stopLoss: string;
  tp1Price: string;
  tp2Price: string;
  tp3Price: string;
  tickSize: string;
  entryClientOrderId: string;
  stopClientOrderId: string;
  tp3ClientOrderId: string;
  trailingClientOrderId: string;
};

export type AdminDemoProviderExecutionSummary = {
  id: string;
  sessionId: string;
  adminUserId: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryOrderType: 'MARKET' | 'LIMIT';
  executionStatus: string;
  protectionStatus: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type AdminDemoProviderExecution = AdminDemoProviderExecutionSummary & {
  authorizationId: string;
  entryClientOrderId: string;
  entryExchangeOrderId: string | null;
  quantity: string;
  entryPrice: string;
  stopLoss: string;
  tp1Price: string;
  tp2Price: string;
  tp3Price: string;
  tickSize: string;
  stopClientOrderId: string;
  tp3ClientOrderId: string;
  trailingClientOrderId: string;
  stopProtectionId: string | null;
  tp3ProtectionId: string | null;
  trailingProtectionId: string | null;
  tp1ReachedAt: string | null;
  tp2ReachedAt: string | null;
  executionMode: 'CONFIRM';
};

export type AdminDemoProviderExecutionUpdate = {
  executionStatus?: AdminDemoProviderExecutionStatus;
  protectionStatus?: AdminDemoProviderProtectionStatus;
  filledQuantity?: string;
  entryExchangeOrderId?: string;
  stopProtectionId?: string;
  tp3ProtectionId?: string;
  trailingProtectionId?: string;
  tp1Reached?: boolean;
  tp2Reached?: boolean;
};

export type AdminDemoProviderExecutionStatus =
  | 'CREATED'
  | 'ENTRY_SUBMITTING'
  | 'ENTRY_UNKNOWN'
  | 'ENTRY_FILLED'
  | 'PROTECTED'
  | 'RECONCILIATION_REQUIRED'
  | 'CLOSED'
  | 'FAILED'
  | 'REVOKED';

export type AdminDemoProviderProtectionStatus =
  | 'PENDING'
  | 'PROTECTED'
  | 'TRAILING'
  | 'FAILED'
  | 'CLOSED';

export type AdminDemoProviderAuditEvent = {
  id: string;
  sessionId: string | null;
  authorizationId: string | null;
  adminUserId: number;
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  eventType: string;
  eventStatus: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'BLOCKED';
  safeDetails: Record<string, unknown>;
  createdAt: string;
};

export type AdminDemoProviderAccountSnapshot = {
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  connected: boolean;
  capabilities: Readonly<AdminDemoProviderCapabilities>;
  balances: ExchangeBalance[];
  instruments: ExchangeInstrument[];
  positions: ExchangePosition[];
};

export type AdminDemoProviderRepository = {
  listCredentialStatuses(adminUserId: number): Promise<AdminDemoProviderCredentialStatus[]>;
  getCredentialStatus(
    adminUserId: number,
    provider: AdminDemoProvider,
  ): Promise<AdminDemoProviderCredentialStatus>;
  getCredential(
    adminUserId: number,
    provider: AdminDemoProvider,
  ): Promise<AdminDemoProviderCredential | null>;
  saveCredential(
    adminUserId: number,
    provider: AdminDemoProvider,
    credential: AdminDemoProviderCredentialInput,
  ): Promise<AdminDemoProviderCredentialStatus>;
  revokeCredential(adminUserId: number, provider: AdminDemoProvider, options?: { erase?: boolean }): Promise<boolean>;
  listSessions(
    adminUserId: number,
    provider: AdminDemoProvider,
    limit: number,
  ): Promise<AdminDemoProviderSession[]>;
  createSession(
    adminUserId: number,
    provider: AdminDemoProvider,
    input: AdminDemoProviderSessionInput,
  ): Promise<AdminDemoProviderSession>;
  getSession(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
  ): Promise<AdminDemoProviderSession | null>;
  createAuthorization(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    expiresInSeconds: number,
    permittedActions: Array<'START_TEST' | 'RECONCILE'>,
  ): Promise<AdminDemoProviderAuthorization>;
  renewReconciliationAuthorization(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    authorizationId: string,
    expiresInSeconds: number,
  ): Promise<AdminDemoProviderAuthorization>;
  revokeAuthorization(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    authorizationId: string,
  ): Promise<boolean>;
  authorizeAction(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    authorizationId: string,
    action: AdminDemoProviderAuthorizationAction,
  ): Promise<boolean>;
  reserveExecution(
    adminUserId: number,
    provider: AdminDemoProvider,
    input: AdminDemoProviderExecutionInput,
  ): Promise<'CREATED' | 'EXISTING' | 'BUSY'>;
  getExecution(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
  ): Promise<AdminDemoProviderExecution | null>;
  updateExecutionProgress(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    update: AdminDemoProviderExecutionUpdate,
    authorizationId: string,
    reconciliationLockToken?: string,
  ): Promise<AdminDemoProviderExecution>;
  updateExecutionStatus(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    status: AdminDemoProviderExecutionStatus,
    protectionStatus?: AdminDemoProviderProtectionStatus,
  ): Promise<AdminDemoProviderExecutionSummary>;
  listExecutions(
    adminUserId: number,
    provider: AdminDemoProvider,
    limit: number,
  ): Promise<AdminDemoProviderExecutionSummary[]>;
  claimReconciliation(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    authorizationId: string,
    lockToken: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  verifyReconciliationLease(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    authorizationId: string,
    lockToken: string,
    minimumValiditySeconds?: number,
  ): Promise<boolean>;
  releaseReconciliation(
    adminUserId: number,
    provider: AdminDemoProvider,
    sessionId: string,
    lockToken: string,
  ): Promise<boolean>;
  listAuditEvents(
    adminUserId: number,
    provider: AdminDemoProvider,
    limit: number,
  ): Promise<AdminDemoProviderAuditEvent[]>;
  appendAuditEvent(input: {
    adminUserId: number;
    provider: AdminDemoProvider;
    sessionId?: string;
    authorizationId?: string;
    eventType: string;
    eventStatus: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' | 'BLOCKED';
    safeDetails?: Record<string, unknown>;
  }): Promise<void>;
};

export type AdminDemoProviderInfo = {
  provider: AdminDemoProvider;
  environment: AdminDemoProviderEnvironment;
  capabilities: Readonly<AdminDemoProviderCapabilities>;
  credential: AdminDemoProviderCredentialStatus;
};
