import type { NextRequest } from 'next/server';
import {
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
    const scope = await resolveProvider(request, provider);
    const service = await getProviderService();
    return service.getBalance(admin, scope.provider);
  });
}
