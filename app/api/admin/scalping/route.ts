import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import {
  getHighRiskScalpingSettings,
  SCALPING_TIMEFRAMES,
  updateHighRiskScalpingSettings,
} from '../../../../lib/high-risk-scalping';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const minutesSchema = z.object({
  '1m': z.number().int().min(1).max(240),
  '3m': z.number().int().min(1).max(240),
  '5m': z.number().int().min(1).max(240),
  '15m': z.number().int().min(1).max(240),
}).strict();
const settingsSchema = z.object({
  enabled: z.boolean(),
  enabledTimeframes: z.array(z.enum(SCALPING_TIMEFRAMES)).min(1).max(4).refine((items) => new Set(items).size === items.length),
  minimumSetupScore: z.number().int().min(50).max(100),
  minimumQuoteVolume: z.number().finite().min(0).max(1_000_000_000_000),
  minimumRelativeVolume: z.number().finite().min(1).max(20),
  entryValidityMinutes: minutesSchema,
  signalValidityMinutes: minutesSchema,
}).strict();

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ data: await getHighRiskScalpingSettings() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Scalping settings are unavailable.' }, { status });
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    await requireAdmin();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid scalping settings.' }, { status: 400 }); }
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scalping settings.' }, { status: 422 });
    await updateHighRiskScalpingSettings(parsed.data);
    return NextResponse.json({ data: await getHighRiskScalpingSettings() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Scalping settings could not be saved.' }, { status });
  }
}
