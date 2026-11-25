import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import { getStrategyProfiles, saveStrategyProfile, StrategySettingsError } from '../../../../lib/strategy-management';
import { EXCHANGE_IDS, isExchangeEnvironment, type ExchangeId } from '../../../../lib/exchanges/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const profileSchema = z.object({
  strategy: z.enum(['STANDARD', 'HIGH_RISK_SCALPING']),
  exchange: z.enum(EXCHANGE_IDS),
  environment: z.enum(['DEMO', 'TESTNET', 'LIVE']),
  enabled: z.boolean(),
  execution_mode: z.enum(['CONFIRM', 'AUTOMATIC']),
  risk_percentage: z.string().regex(/^(?:0\.[0-9]{1,2}|[1-9]\d?(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/).refine((value) => Number(value) > 0 && Number(value) <= 100),
  order_size_mode: z.enum(['FIXED', 'RISK_BASED']),
  fixed_notional_usdt: z.string().regex(/^\d{1,12}(?:\.\d{1,8})?$/).refine((value) => Number(value) > 0),
  leverage: z.number().int().min(1).max(125),
  max_open_positions: z.number().int().min(1).max(100).nullable(),
  max_daily_loss_percent: z.string().regex(/^(?:0\.[0-9]{1,2}|[1-9]\d?(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/).refine((value) => Number(value) > 0 && Number(value) <= 100).nullable(),
  auto_execution_enabled: z.boolean(),
  emergency_stop_enabled: z.boolean(),
  confirmEnable: z.boolean().default(false),
  confirmAutomatic: z.boolean().default(false),
  confirmEmergencyStopReset: z.boolean().default(false),
  updated_at: z.string().optional(),
}).strip();

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ data: await getStrategyProfiles(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof StrategySettingsError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Strategy settings unavailable.' }, { status });
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Strategy profile settings are invalid.' }, { status: 422 });
    if (!isExchangeEnvironment(parsed.data.exchange as ExchangeId, parsed.data.environment)) {
      return Response.json({ error: 'The selected exchange does not support this environment.' }, { status: 422 });
    }
    await saveStrategyProfile(user.id, parsed.data, {
      confirmEnable: parsed.data.confirmEnable,
      confirmAutomatic: parsed.data.confirmAutomatic,
      confirmEmergencyStopReset: parsed.data.confirmEmergencyStopReset,
    });
    return Response.json({ data: await getStrategyProfiles(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof StrategySettingsError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Strategy profile could not be saved.' }, { status });
  }
}
