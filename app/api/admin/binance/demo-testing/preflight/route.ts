import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '../../../../../../lib/auth';
import { adminDemoApiError, noStoreJson } from '../../../../../../lib/admin-demo-api';
import { createProductionAdminDemoExecutionService } from '../../../../../../lib/admin-demo-execution-service';
import { validCsrf } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  sessionId: z.string().regex(/^[1-9]\d*$/),
  authorizationId: z.string().regex(/^[1-9]\d*$/),
  confirmation: z.literal('RUN_BINANCE_DEMO_LIFECYCLE'),
  config: z.object({
    symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
    direction: z.enum(['LONG', 'SHORT']),
    quantity: z.string(),
    entryPrice: z.string(),
    stopPrice: z.string(),
    tp1Price: z.string(),
    tp2Price: z.string(),
    tp3Price: z.string(),
    tickSize: z.string(),
  }).strict(),
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return noStoreJson({ error: 'Refresh and retry.' }, 403);
  try {
    const admin = await requireAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: 'Invalid Admin Demo preflight request.' }, 422);
    const service = await createProductionAdminDemoExecutionService();
    return noStoreJson({
      data: await service.preflight(
        admin, parsed.data.sessionId, parsed.data.authorizationId,
        parsed.data.config, parsed.data.confirmation,
      ),
    });
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}
