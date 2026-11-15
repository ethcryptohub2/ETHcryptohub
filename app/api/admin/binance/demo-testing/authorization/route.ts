import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '../../../../../../lib/auth';
import { adminDemoApiError, noStoreJson } from '../../../../../../lib/admin-demo-api';
import { createProductionAdminDemoExecutionService } from '../../../../../../lib/admin-demo-execution-service';
import { validCsrf } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), sessionId: z.string().regex(/^[1-9]\d*$/), expiresInSeconds: z.number().int().min(30).max(900).optional() }).strict(),
  z.object({ action: z.literal('revoke'), sessionId: z.string().regex(/^[1-9]\d*$/), authorizationId: z.string().regex(/^[1-9]\d*$/) }).strict(),
]);

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return noStoreJson({ error: 'Refresh and retry.' }, 403);
  try {
    const admin = await requireAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: 'Invalid Admin Demo authorization request.' }, 422);
    const service = await createProductionAdminDemoExecutionService();
    if (parsed.data.action === 'create') {
      return noStoreJson({
        data: await service.createAuthorization(admin, parsed.data.sessionId, parsed.data.expiresInSeconds),
      }, 201);
    }
    return noStoreJson({
      data: { revoked: await service.revokeAuthorization(admin, parsed.data.sessionId, parsed.data.authorizationId) },
    });
  } catch (error) {
    const result = adminDemoApiError(error);
    return noStoreJson({ error: result.error }, result.status);
  }
}
