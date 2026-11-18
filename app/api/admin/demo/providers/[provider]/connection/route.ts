import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  AdminDemoRequestValidationError,
  type AdminDemoRouteContext,
  getProviderService,
  readOptionalJson,
  resolveProvider,
  withMutation,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const body = await readOptionalJson(request);
    const parsed = z.object({ environment: z.enum(['DEMO', 'TESTNET']).optional() })
      .strict().safeParse(body);
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo connection request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    return service.testConnection(admin, scope.provider);
  });
}
