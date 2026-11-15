import type { NextRequest } from 'next/server';
import { requireAdmin } from '../../../../../../lib/auth';
import { adminDemoApiError, noStoreJson } from '../../../../../../lib/admin-demo-api';
import { createProductionAdminDemoExecutionService } from '../../../../../../lib/admin-demo-execution-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const admin = await requireAdmin();
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
    const service = await createProductionAdminDemoExecutionService();
    return noStoreJson({ data: await service.getHistory(admin, sessionId) });
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}
