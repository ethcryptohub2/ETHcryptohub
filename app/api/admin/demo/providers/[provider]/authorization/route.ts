import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  AdminDemoRequestValidationError,
  type AdminDemoRouteContext,
  getProviderService,
  resolveProvider,
  withMutation,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const authorizationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    sessionId: identifier,
    expiresInSeconds: z.number().int().min(30).max(900).optional(),
    environment: z.enum(['DEMO', 'TESTNET']).optional(),
  }).strict(),
  z.object({
    action: z.literal('renewReconciliation'),
    sessionId: identifier,
    authorizationId: identifier,
    expiresInSeconds: z.number().int().min(30).max(900).optional(),
    environment: z.enum(['DEMO', 'TESTNET']).optional(),
  }).strict(),
]);

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const parsed = authorizationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo authorization request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    if (parsed.data.action === 'create') {
      return service.createAuthorization(
        admin,
        scope.provider,
        parsed.data.sessionId,
        parsed.data.expiresInSeconds ?? 300,
      );
    }
    return service.renewReconciliationAuthorization(
      admin,
      scope.provider,
      parsed.data.sessionId,
      parsed.data.authorizationId,
      parsed.data.expiresInSeconds ?? 300,
    );
  }, 201);
}
