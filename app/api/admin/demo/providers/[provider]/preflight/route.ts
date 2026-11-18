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

const positiveDecimal = z.string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);
const preflightSchema = z.object({
  config: z.object({
    symbol: z.string().regex(/^[A-Z0-9:_-]{2,40}$/),
    direction: z.enum(['LONG', 'SHORT']),
    quantity: positiveDecimal,
    entryPrice: positiveDecimal,
    stopLoss: positiveDecimal,
    tp1Price: positiveDecimal,
    tp2Price: positiveDecimal,
    tp3Price: positiveDecimal,
    tickSize: positiveDecimal,
  }).strict(),
  environment: z.enum(['DEMO', 'TESTNET']).optional(),
}).strict();

export async function POST(request: NextRequest, { params }: AdminDemoRouteContext) {
  return withMutation(request, async (admin) => {
    const { provider } = await params;
    const parsed = preflightSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo preflight request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    const service = await getProviderService();
    return service.preflight(admin, scope.provider, parsed.data.config);
  });
}
