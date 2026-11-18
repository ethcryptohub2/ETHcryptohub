import { z } from 'zod';
import type { NextRequest } from 'next/server';
import {
  AdminDemoRequestValidationError,
  type AdminDemoRouteContext,
  getProviderService,
  resolveProvider,
  withAdmin,
  withMutation,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSessionSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9:_-]{2,40}$/).optional(),
  direction: z.enum(['LONG', 'SHORT']).optional(),
  environment: z.enum(['DEMO', 'TESTNET']).optional(),
}).strict();

export async function GET(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withAdmin(async (admin) => {
    const { provider } = await params;
    const scope = await resolveProvider(request, provider, undefined, ['environment', 'limit']);
    const limitValue = new URL(request.url).searchParams.get('limit') ?? '25';
    const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(limitValue);
    if (!parsedLimit.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo session query.');
    }
    const service = await getProviderService();
    return service.listSessions(admin, scope.provider, parsedLimit.data);
  });
}

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo session request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    return service.createSession(admin, scope.provider, {
      ...(parsed.data.symbol ? { symbol: parsed.data.symbol } : {}),
      ...(parsed.data.direction ? { direction: parsed.data.direction } : {}),
    });
  }, 201);
}
