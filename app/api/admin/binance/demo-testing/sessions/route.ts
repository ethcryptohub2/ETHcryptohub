import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '../../../../../../lib/auth';
import { adminDemoApiError, noStoreJson } from '../../../../../../lib/admin-demo-api';
import { createProductionAdminDemoExecutionService } from '../../../../../../lib/admin-demo-execution-service';
import { validCsrf } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,30}$/),
  direction: z.enum(['LONG', 'SHORT']),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const admin = await requireAdmin();
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
    const service = await createProductionAdminDemoExecutionService();
    return noStoreJson({ data: await service.getStatus(admin, sessionId) });
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return noStoreJson({ error: 'Refresh and retry.' }, 403);
  try {
    const admin = await requireAdmin();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: 'Invalid Admin Demo session request.' }, 422);
    const service = await createProductionAdminDemoExecutionService();
    return noStoreJson({ data: await service.createSession(admin, parsed.data) }, 201);
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}
