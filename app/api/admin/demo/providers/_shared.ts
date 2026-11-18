import type { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../../lib/auth';
import { createServerAdminDemoProviderService } from '../../../../../lib/admin-demo-provider-service';
import {
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  isAdminDemoProvider,
  type AdminDemoProvider,
  type AdminDemoProviderEnvironment,
} from '../../../../../lib/admin-demo-provider-contract';
import {
  AdminDemoProviderSecurityError,
  assertAdminDemoProviderActor,
  assertAdminDemoProviderEnvironment,
  guardAdminDemoProviderMutation,
  type AdminDemoProviderAdmin,
} from '../../../../../lib/admin-demo-provider-security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export class AdminDemoRequestValidationError extends Error {
  constructor(message = 'Invalid Admin Demo provider request.') {
    super(message);
    this.name = 'AdminDemoRequestValidationError';
  }
}

export type AdminDemoRouteContext = {
  params: Promise<{ provider: string }>;
};

export function noStoreJson(data: unknown, status = 200) {
  return Response.json(sanitizeResponse(data), { status, headers: NO_STORE_HEADERS });
}

export async function readOptionalJson(request: NextRequest): Promise<unknown> {
  const body = await request.text();
  if (body.trim() === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      /^(?:api_?key|api_?secret|passphrase|secret|.*ciphertext|service_?role(?:_?key)?|access_?token)$/i
        .test(key)
    ) {
      continue;
    }
    result[key] = sanitizeResponse(nested);
  }
  return result;
}

export function errorResponse(error: unknown, failureMessage = 'Admin Demo provider action is unavailable.') {
  if (error instanceof AuthError) return noStoreJson({ error: error.message }, error.status);
  if (error instanceof AdminDemoProviderSecurityError) {
    return noStoreJson({ error: error.message }, error.status);
  }
  if (error instanceof AdminDemoRequestValidationError) {
    return noStoreJson({ error: error.message }, 422);
  }
  const errorClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.constructor.name)
    ? error.constructor.name
    : 'UnknownError';
  console.error(`Unexpected Admin Demo provider route failure (${errorClass}).`);
  return noStoreJson({ error: failureMessage }, 503);
}

export function assertAllowedQuery(request: NextRequest, allowed: readonly string[]) {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (!allowed.includes(key) || search.getAll(key).length !== 1) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo query parameters.');
    }
  }
}

export async function resolveProvider(
  request: NextRequest,
  rawProvider: string,
  suppliedEnvironment?: unknown,
  allowedQuery: readonly string[] = ['environment'],
): Promise<{ provider: AdminDemoProvider; environment: AdminDemoProviderEnvironment }> {
  assertAllowedQuery(request, allowedQuery);
  const queryEnvironment = new URL(request.url).searchParams.get('environment') ?? undefined;
  if (!isAdminDemoProvider(rawProvider)) {
    throw new AdminDemoProviderSecurityError('Admin Demo provider is invalid.', 400);
  }
  const environment = ADMIN_DEMO_PROVIDER_ENVIRONMENTS[rawProvider];
  if (queryEnvironment !== undefined) assertAdminDemoProviderEnvironment(rawProvider, queryEnvironment);
  if (suppliedEnvironment !== undefined) {
    assertAdminDemoProviderEnvironment(rawProvider, suppliedEnvironment);
  }
  return { provider: rawProvider, environment };
}

export async function withAdmin<T>(
  operation: (admin: AdminDemoProviderAdmin) => Promise<T>,
  status = 200,
): Promise<Response> {
  try {
    const admin = await requireAdmin();
    assertAdminDemoProviderActor(admin);
    return noStoreJson({ data: await operation(admin as AdminDemoProviderAdmin) }, status);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function withMutation<T>(
  request: NextRequest,
  operation: (admin: AdminDemoProviderAdmin) => Promise<T>,
  status = 200,
): Promise<Response> {
  try {
    const admin = await requireAdmin();
    assertAdminDemoProviderActor(admin);
    const rejected = guardMutation(request);
    if (rejected) return rejected;
    return noStoreJson({ data: await operation(admin as AdminDemoProviderAdmin) }, status);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getProviderService() {
  return await createServerAdminDemoProviderService();
}

export function guardMutation(request: NextRequest): Response | null {
  // The helper response is intentionally replaced so rejected mutations also get no-store headers.
  const rejected = guardAdminDemoProviderMutation(request);
  return rejected ? noStoreJson({ error: 'Refresh and retry.' }, 403) : null;
}
