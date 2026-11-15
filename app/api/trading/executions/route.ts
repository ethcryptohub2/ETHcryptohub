import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { listUserExecutions } from '../../../../lib/trading-execution';
import { EXCHANGE_IDS } from '../../../../lib/exchanges/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  status: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
  symbol: z.string().trim().min(1).max(30).optional(),
  environment: z.enum(['DEMO', 'LIVE', 'ALL']).default('ALL'),
  strategy: z.enum(['STANDARD', 'HIGH_RISK_SCALPING', 'ALL']).default('ALL'),
  exchange: z.enum([...EXCHANGE_IDS, 'ALL']).default('ALL'),
  direction: z.enum(['LONG', 'SHORT', 'ALL']).default('ALL'),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return Response.json({ error: 'Invalid execution history filter.' }, { status: 422 });
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return Response.json({ error: 'The start date must be on or before the end date.' }, { status: 422 });
    }
    const data = await listUserExecutions(user.id, parsed.data);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Execution history is unavailable.' }, { status });
  }
}
