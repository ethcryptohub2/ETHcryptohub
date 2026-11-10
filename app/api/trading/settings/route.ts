import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import { getTradingSettings, setActiveTradingEnvironment, updateTradingSettings } from '../../../../lib/trading-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  environment: z.enum(['DEMO', 'LIVE']),
  order_size_mode: z.enum(['FIXED', 'RISK_BASED']),
  fixed_notional_usdt: z.string().regex(/^\d{1,12}(?:\.\d{1,8})?$/).refine((value) => Number(value) > 0),
  risk_percentage: z.string().regex(/^(?:0\.[0-9]{1,2}|[1-4](?:\.[0-9]{1,2})?|5(?:\.0{1,2})?)$/).refine((value) => Number(value) > 0 && Number(value) <= 5),
  default_leverage: z.number().int().min(1).max(125),
  execution_mode: z.enum(['CONFIRM', 'AUTOMATIC']),
}).strict();
const environmentSchema = z.object({
  environment: z.enum(['DEMO', 'LIVE']),
  confirmLive: z.literal(true).optional(),
}).strict();

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ data: await getTradingSettings(user.id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Trading settings unavailable.' }, { status });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = environmentSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid trading environment selection.' }, { status: 422 });
    if (parsed.data.environment === 'LIVE' && parsed.data.confirmLive !== true) {
      return Response.json({ error: 'Explicit confirmation is required before switching to Live Trading.' }, { status: 422 });
    }
    const data = await setActiveTradingEnvironment(user.id, parsed.data.environment);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Trading environment could not be changed.' }, { status });
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Trading settings are invalid.' }, { status: 422 });
    const data = await updateTradingSettings(user.id, parsed.data.environment, parsed.data);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Trading settings could not be saved.' }, { status });
  }
}
