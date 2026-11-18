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
const executionSchema = z.object({
  sessionId: z.string().regex(/^[1-9]\d*$/).max(128),
  authorizationId: z.string().regex(/^[1-9]\d*$/).max(128),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/),
  confirmation: z.literal('PLACE_ADMIN_DEMO_ORDER'),
  executionMode: z.literal('CONFIRM').optional(),
  entryOrderType: z.literal('LIMIT'),
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
    const parsed = executionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AdminDemoRequestValidationError('Invalid Admin Demo execution request.');
    }
    const scope = await resolveProvider(request, provider, parsed.data.environment);
    if (scope.provider !== 'BYBIT' || scope.environment !== 'DEMO') {
      throw new AdminDemoRequestValidationError('Admin Demo execution is restricted to BYBIT DEMO.');
    }
    const service = await getProviderService();
    return service.execute(admin, scope.provider, parsed.data);
  });
}
