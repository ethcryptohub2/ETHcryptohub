import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { listUserExecutions } from '../../../../lib/trading-execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  status: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
  symbol: z.string().trim().min(1).max(30).optional(),
  environment: z.enum(['DEMO', 'LIVE', 'ALL']).default('ALL'),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return Response.json({ error: 'Invalid execution history filter.' }, { status: 422 });
    const data = await listUserExecutions(user.id, parsed.data);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Execution history is unavailable.' }, { status });
  }
}
