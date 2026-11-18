import 'server-only';

import { AuthError, requireAdmin } from './auth';
import { guardedPost } from './http';
import {
  assertAdminDemoProviderEnvironment as assertFixedAdminDemoProviderEnvironment,
  isAdminDemoProvider,
  type AdminDemoProvider,
  type AdminDemoProviderCapabilities,
  type AdminDemoProviderEnvironment,
} from './admin-demo-provider-contract';
import type { AdminDemoProviderSessionStatus } from './admin-demo-provider-backend-contract';
import type { NextRequest } from 'next/server';
import type { User } from './auth';

export class AdminDemoProviderSecurityError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AdminDemoProviderSecurityError';
  }
}

export type AdminDemoProviderAdmin = Pick<User, 'id' | 'role' | 'is_active'> & { role: 'admin' };

export function assertAdminDemoProviderActor(actor: unknown): asserts actor is AdminDemoProviderAdmin {
  const candidate = actor as Partial<AdminDemoProviderAdmin> | null;
  if (
    !candidate ||
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    candidate.role !== 'admin' ||
    candidate.is_active !== 1
  ) {
    throw new AuthError(403, 'Administrator access is required.');
  }
}

export async function requireAdminDemoAdmin(): Promise<AdminDemoProviderAdmin> {
  const user = await requireAdmin();
  assertAdminDemoProviderActor(user);
  return user as AdminDemoProviderAdmin;
}

export function guardAdminDemoProviderMutation(request: NextRequest): Response | null {
  return guardedPost(request);
}

export function assertAdminDemoProviderEnvironment(
  provider: unknown,
  environment: unknown,
): { provider: AdminDemoProvider; environment: AdminDemoProviderEnvironment } {
  if (!isAdminDemoProvider(provider)) {
    throw new AdminDemoProviderSecurityError('Admin Demo provider is invalid.', 400);
  }
  try {
    assertFixedAdminDemoProviderEnvironment(provider, environment);
  } catch {
    throw new AdminDemoProviderSecurityError(
      'Admin Demo provider environment does not match the fixed provider configuration.',
      400,
    );
  }
  return { provider, environment: environment as AdminDemoProviderEnvironment };
}

export type AdminDemoProviderCapability = keyof AdminDemoProviderCapabilities;

export function assertAdminDemoProviderCapability(
  capabilities: Readonly<Partial<AdminDemoProviderCapabilities>> | null | undefined,
  capability: AdminDemoProviderCapability,
): void {
  if (capabilities?.[capability] !== true) {
    throw new AdminDemoProviderSecurityError(
      `Admin Demo capability "${capability}" is unavailable.`,
      503,
    );
  }
}

export const requireAdminDemoProviderCapability = assertAdminDemoProviderCapability;

export function requireAdminDemoExecutionCapabilities(
  capabilities: Readonly<Partial<AdminDemoProviderCapabilities>> | null | undefined,
  entryOrderType: 'MARKET' | 'LIMIT',
): void {
  assertAdminDemoProviderCapability(capabilities, 'adminLifecycle');
  assertAdminDemoProviderCapability(
    capabilities,
    entryOrderType === 'MARKET' ? 'marketEntry' : 'limitEntry',
  );
  assertAdminDemoProviderCapability(capabilities, 'stopLossProtection');
  assertAdminDemoProviderCapability(capabilities, 'takeProfitProtection');
  assertAdminDemoProviderCapability(capabilities, 'trailingProtection');
  assertAdminDemoProviderCapability(capabilities, 'reduceOnlyClose');
}

export function requireAdminDemoReconciliationCapability(
  capabilities: Readonly<Partial<AdminDemoProviderCapabilities>> | null | undefined,
): void {
  assertAdminDemoProviderCapability(capabilities, 'adminLifecycle');
  assertAdminDemoProviderCapability(capabilities, 'reconciliation');
}

export function requireAdminDemoExecutionConfirmation(
  confirmation: unknown,
  expectedConfirmation: string,
): void {
  if (
    typeof confirmation !== 'string' ||
    expectedConfirmation.length === 0 ||
    confirmation !== expectedConfirmation
  ) {
    throw new AdminDemoProviderSecurityError(
      'Explicit Admin Demo operator confirmation is required.',
      422,
    );
  }
}

const RECONCILIATION_SESSION_STATUSES: readonly AdminDemoProviderSessionStatus[] = [
  'RUNNING',
  'RECONCILIATION_REQUIRED',
];

export function requireAdminDemoReconciliationRenewal(
  session: { id: string; status: AdminDemoProviderSessionStatus } | null | undefined,
  permittedActions: readonly string[] = ['RECONCILE'],
): readonly ['RECONCILE'] {
  if (
    !session ||
    typeof session.id !== 'string' ||
    session.id.trim() === '' ||
    !RECONCILIATION_SESSION_STATUSES.includes(session.status)
  ) {
    throw new AdminDemoProviderSecurityError(
      'Reconciliation authorization can only be renewed for an existing active session.',
      409,
    );
  }
  if (permittedActions.length !== 1 || permittedActions[0] !== 'RECONCILE') {
    throw new AdminDemoProviderSecurityError(
      'Reconciliation renewal may authorize RECONCILE only.',
      403,
    );
  }
  return ['RECONCILE'];
}
