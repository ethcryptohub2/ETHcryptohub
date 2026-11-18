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

const identifier = z.string().max(128).regex(/^[1-9]\d*$/);
const reconcileSchema = z.object({
  sessionId: identifier,
  authorizationId: identifier,
  environment: z.enum(['DEMO', 'TESTNET']).optional(),
}).strict();

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const parsed = reconcileSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo reconciliation request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    if (scope.provider !== 'BYBIT' || scope.environment !== 'DEMO') {
      throw new AdminDemoRequestValidationError('Admin Demo reconciliation is restricted to BYBIT DEMO.');
    }
    const service = await getProviderService();
    return service.reconcile(
      admin,
      scope.provider,
      parsed.data.sessionId,
      parsed.data.authorizationId,
    );
  });
}
