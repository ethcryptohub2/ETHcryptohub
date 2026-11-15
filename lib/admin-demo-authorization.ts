export type AdminDemoAction = 'START_TEST' | 'RECONCILE';

export type AdminDemoAuthorization = {
  id: string;
  adminUserId: number;
  sessionId: string;
  testAccountId: string;
  exchange: string;
  environment: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  permittedActions: readonly string[];
  expiresAt: string;
  consumedAt: string | null;
};

export type AdminDemoAuthorizationContext = {
  adminUserId: number;
  sessionId: string;
  testAccountId: string;
  authorizationId: string;
  exchange: string;
  environment: string;
  action: AdminDemoAction;
};

export interface AdminDemoAuthorizationRepository {
  authorizeAction(context: AdminDemoAuthorizationContext): Promise<AdminDemoAuthorization | null>;
}

export class AdminDemoSchemaNotReadyError extends Error {
  constructor() {
    super('Admin Demo authorization schema is not ready. Apply the approved Admin Demo migrations before continuing.');
    this.name = 'AdminDemoSchemaNotReadyError';
  }
}

export async function requirePersistentAdminDemoAuthorization(
  repository: AdminDemoAuthorizationRepository,
  context: AdminDemoAuthorizationContext,
  now = Date.now(),
) {
  const authorization = await repository.authorizeAction(context);
  if (!authorization) {
    throw new Error('Admin Demo authorization is unavailable, expired, revoked, replayed, or concurrently consumed.');
  }
  assertAdminDemoAuthorization(authorization, context, now, context.action === 'START_TEST');
  return authorization;
}

export function assertAdminDemoAuthorization(
  authorization: AdminDemoAuthorization,
  context: AdminDemoAuthorizationContext,
  now = Date.now(),
  requireConsumedStart = false,
) {
  const expiry = Date.parse(authorization.expiresAt);
  if (
    !Number.isSafeInteger(context.adminUserId) ||
    context.adminUserId <= 0 ||
    !/^[1-9]\d*$/.test(authorization.id) ||
    !/^[1-9]\d*$/.test(authorization.sessionId) ||
    !/^[1-9]\d*$/.test(authorization.testAccountId) ||
    context.adminUserId !== authorization.adminUserId ||
    !/^[1-9]\d*$/.test(context.sessionId) ||
    !/^[1-9]\d*$/.test(context.testAccountId) ||
    !/^[1-9]\d*$/.test(context.authorizationId) ||
    context.sessionId !== authorization.sessionId ||
    context.testAccountId !== authorization.testAccountId ||
    context.exchange !== 'BINANCE' ||
    context.exchange !== authorization.exchange ||
    context.environment !== 'DEMO' ||
    context.environment !== authorization.environment ||
    authorization.status !== 'ACTIVE' ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !authorization.permittedActions.includes(context.action) ||
    (context.action === 'START_TEST' &&
      (requireConsumedStart ? authorization.consumedAt === null : authorization.consumedAt !== null))
  ) {
    throw new Error('Admin Demo authorization is invalid, expired, revoked, reused, or out of scope.');
  }
}

export type AdminDemoRpcClient = {
  rpc(
    functionName: 'authorize_admin_demo_test_action',
    parameters: {
      p_admin_user_id: number;
      p_session_id: string;
      p_authorization_id: string;
      p_action: AdminDemoAction;
    },
  ): Promise<{ data: unknown; error: { code?: string } | null }>;
};

export type AdminDemoAuthorizationReader = {
  getAuthorization(context: AdminDemoAuthorizationContext): Promise<AdminDemoAuthorization | null>;
};

export function createPersistentAdminDemoAuthorizationRepository(
  rpcClient: AdminDemoRpcClient,
  reader: AdminDemoAuthorizationReader,
): AdminDemoAuthorizationRepository {
  return {
    async authorizeAction(context) {
      let result: Awaited<ReturnType<AdminDemoRpcClient['rpc']>>;
      try {
        result = await rpcClient.rpc('authorize_admin_demo_test_action', {
          p_admin_user_id: context.adminUserId,
          p_session_id: context.sessionId,
          p_authorization_id: context.authorizationId,
          p_action: context.action,
        });
      } catch {
        throw new Error('Admin Demo authorization service is unavailable.');
      }

      if (result.error) {
        if (['PGRST202', '42883', '42P01'].includes(result.error.code ?? '')) {
          throw new AdminDemoSchemaNotReadyError();
        }
        throw new Error('Admin Demo authorization service is unavailable.');
      }
      if (result.data !== true) return null;
      return reader.getAuthorization(context);
    },
  };
}
