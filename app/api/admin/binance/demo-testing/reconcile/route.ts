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
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return noStoreJson({ error: 'Refresh and retry.' }, 403);
  try {
    const admin = await requireAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: 'Invalid Admin Demo reconciliation request.' }, 422);
    const service = await createProductionAdminDemoExecutionService();
    return noStoreJson({
      data: await service.reconcile(
        admin, parsed.data.sessionId, parsed.data.authorizationId, parsed.data.confirmation,
      ),
    });
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}
