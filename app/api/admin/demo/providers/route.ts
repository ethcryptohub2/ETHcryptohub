import type { NextRequest } from 'next/server';
import { assertAllowedQuery, getProviderService, withAdmin } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return withAdmin(async (admin) => {
    assertAllowedQuery(request, []);
    const service = await getProviderService();
    return service.listProviders(admin);
  });
}
