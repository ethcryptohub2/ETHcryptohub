import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { BinanceFuturesError } from '../../../../lib/binance-futures';
import { executeSignal } from '../../../../lib/trading-execution';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  signalId: z.string().regex(/^\d+$/),
  environment: z.enum(['DEMO', 'LIVE']),
  confirm: z.literal(true),
  expected: z.object({
    environment: z.enum(['DEMO', 'LIVE']),
    referenceEntryPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
    currentMarkPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
    quantity: z.string().regex(/^\d+(?:\.\d+)?$/),
    notionalUsdt: z.string().regex(/^\d+(?:\.\d+)?$/),
    leverage: z.number().int().min(1).max(125),
    stopLoss: z.string().regex(/^\d+(?:\.\d+)?$/),
    takeProfit: z.string().regex(/^\d+(?:\.\d+)?$/),
  }).strict(),
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Explicit trade confirmation is required.' }, { status: 422 });
    if (parsed.data.environment !== parsed.data.expected.environment) {
      return Response.json({ error: 'The confirmed environment does not match the selected environment.' }, { status: 422 });
    }
    const data = await executeSignal(user.id, parsed.data.signalId, parsed.data.environment, 'CONFIRM', parsed.data.expected);
    return Response.json({ data }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Trade execution failed.' }, { status });
  }
}
