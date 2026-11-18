import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  AdminDemoRequestValidationError,
  type AdminDemoRouteContext,
  getProviderService,
  resolveProvider,
  withAdmin,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withAdmin(async (admin) => {
    const { provider } = await params;
    const scope = await resolveProvider(request, provider, undefined, ['environment', 'limit']);
    const paramsFromUrl = new URL(request.url).searchParams;
    const limit = z.coerce.number().int().min(1).max(100)
      .safeParse(paramsFromUrl.get('limit') ?? '50');
    if (paramsFromUrl.has('sessionId') || !limit.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo history query.');
    }
    const service = await getProviderService();
    return service.listHistory(admin, scope.provider, limit.data);
  });
}
