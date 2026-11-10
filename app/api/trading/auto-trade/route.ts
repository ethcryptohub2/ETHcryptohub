import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { BinanceFuturesError, verifyFuturesTradingPermission } from '../../../../lib/binance-futures';
import { validCsrf } from '../../../../lib/http';
import { getTradingSettings, setAutoTradeEnabled } from '../../../../lib/trading-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  environment: z.enum(['DEMO', 'LIVE']),
  enabled: z.boolean(),
  confirmDemoRisk: z.literal(true).optional(),
  confirmLiveRisk: z.literal(true).optional(),
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid auto-trade request.' }, { status: 422 });
    if (!parsed.data.enabled) {
      return Response.json({ data: await setAutoTradeEnabled(user.id, parsed.data.environment, false) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const settings = await getTradingSettings(user.id);
    if (settings.active_environment !== parsed.data.environment) {
      return Response.json({ error: 'Select the same environment before enabling its automatic execution.' }, { status: 409 });
    }
    if (parsed.data.environment === 'DEMO') {
      if (parsed.data.confirmDemoRisk !== true) {
        return Response.json({ error: 'Explicit confirmation of Demo automated order risk is required.' }, { status: 422 });
      }
      if (settings.demo_execution_mode !== 'AUTOMATIC' || settings.demo_kill_switch_enabled) {
        return Response.json({ error: 'Select Demo Automatic mode and disable the Demo emergency stop first.' }, { status: 409 });
      }
    } else {
      if (parsed.data.confirmLiveRisk !== true) {
        return Response.json({ error: 'Separate explicit confirmation of Live automated trading risk is required.' }, { status: 422 });
      }
      if (settings.live_execution_mode !== 'AUTOMATIC' || settings.live_kill_switch_enabled) {
        return Response.json({ error: 'Select Live Automatic mode and disable the Live emergency stop first.' }, { status: 409 });
      }
    }
    await verifyFuturesTradingPermission(user.id, parsed.data.environment);
    return Response.json({ data: await setAutoTradeEnabled(user.id, parsed.data.environment, true) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Auto-trade could not be updated.' }, { status });
  }
}
