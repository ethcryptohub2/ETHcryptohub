import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { BinanceFuturesError } from '../../../../lib/binance-futures';
import { validCsrf } from '../../../../lib/http';
import { previewSignalOrder } from '../../../../lib/trading-execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  signalId: z.string().regex(/^\d+$/),
  environment: z.enum(['DEMO', 'LIVE']),
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid signal preview request.' }, { status: 422 });
    const data = await previewSignalOrder(user.id, parsed.data.signalId, parsed.data.environment);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Order preview is unavailable.' }, { status });
  }
}
