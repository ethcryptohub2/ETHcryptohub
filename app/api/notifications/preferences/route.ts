import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import {
  getExtendedAlarmPreferences,
  getNotificationPreferences,
  updateExtendedAlarmPreferences,
  updateNotificationPreferences,
} from '../../../../lib/notifications';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const extendedFieldsSchema = {
  duration: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal('full')]).optional(),
  ringtone: z.enum(['coin-drop', 'sharp-bell', 'digital-beep', 'high-conviction-siren', 'custom-mp3']).optional(),
  master_enabled: z.boolean().optional(),
  standard_strategy_enabled: z.boolean().optional(),
  high_risk_strategy_enabled: z.boolean().optional(),
  repeated_trade_enabled: z.boolean().optional(),
  trade_execution_enabled: z.boolean().optional(),
  exchange_failure_enabled: z.boolean().optional(),
};

const preferencesSchema = z.object({
  push_enabled: z.boolean(),
  sound_enabled: z.boolean(),
  long_enabled: z.boolean(),
  short_enabled: z.boolean(),
  high_conviction_enabled: z.boolean(),
  tp1_enabled: z.boolean(),
  tp2_enabled: z.boolean(),
  tp3_enabled: z.boolean(),
  stop_loss_enabled: z.boolean(),
  expiry_enabled: z.boolean(),
  minimum_setup_score: z.number().int().min(0).max(100),
  alarm_volume: z.number().min(0).max(1),
  quiet_hours_enabled: z.boolean(),
  quiet_hours_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  quiet_hours_end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  quiet_hours_timezone: z.string().min(1).max(64),
  do_not_disturb: z.boolean(),
  ...extendedFieldsSchema,
}).strict();

const partialPreferencesSchema = z.object({
  push_enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  long_enabled: z.boolean().optional(),
  short_enabled: z.boolean().optional(),
  high_conviction_enabled: z.boolean().optional(),
  tp1_enabled: z.boolean().optional(),
  tp2_enabled: z.boolean().optional(),
  tp3_enabled: z.boolean().optional(),
  stop_loss_enabled: z.boolean().optional(),
  expiry_enabled: z.boolean().optional(),
  minimum_setup_score: z.number().int().min(0).max(100).optional(),
  alarm_volume: z.number().min(0).max(1).optional(),
  quiet_hours_enabled: z.boolean().optional(),
  quiet_hours_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  quiet_hours_end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  quiet_hours_timezone: z.string().min(1).max(64).optional(),
  do_not_disturb: z.boolean().optional(),
  ...extendedFieldsSchema,
}).strict();

async function getMergedPreferences(userId: number) {
  const [core, extended] = await Promise.all([
    getNotificationPreferences(userId),
    getExtendedAlarmPreferences(userId),
  ]);
  return { ...core, ...extended, userId };
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ data: await getMergedPreferences(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification preferences are unavailable.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid notification preferences.' }, { status: 400 }); }
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid notification preferences.' }, { status: 422 });
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.quiet_hours_timezone }).format();
    } catch {
      return NextResponse.json({ error: 'Choose a valid quiet-hours time zone.' }, { status: 422 });
    }
    const {
      duration,
      ringtone,
      master_enabled,
      standard_strategy_enabled,
      high_risk_strategy_enabled,
      repeated_trade_enabled,
      trade_execution_enabled,
      exchange_failure_enabled,
      ...corePrefs
    } = parsed.data;
    await updateNotificationPreferences(user.id, corePrefs);
    await updateExtendedAlarmPreferences(user.id, {
      duration,
      ringtone,
      master_enabled,
      standard_strategy_enabled,
      high_risk_strategy_enabled,
      repeated_trade_enabled,
      trade_execution_enabled,
      exchange_failure_enabled,
    });
    return NextResponse.json({ data: await getMergedPreferences(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification preferences could not be saved.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid notification preferences.' }, { status: 400 }); }
    const parsed = partialPreferencesSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid notification preferences.' }, { status: 422 });
    if (parsed.data.quiet_hours_timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.quiet_hours_timezone }).format();
      } catch {
        return NextResponse.json({ error: 'Choose a valid quiet-hours time zone.' }, { status: 422 });
      }
    }

    const current = await getNotificationPreferences(user.id);
    const {
      duration,
      ringtone,
      master_enabled,
      standard_strategy_enabled,
      high_risk_strategy_enabled,
      repeated_trade_enabled,
      trade_execution_enabled,
      exchange_failure_enabled,
      ...corePatch
    } = parsed.data;

    if (Object.keys(corePatch).length > 0) {
      await updateNotificationPreferences(user.id, { ...current, ...corePatch });
    }
    if (
      duration !== undefined ||
      ringtone !== undefined ||
      master_enabled !== undefined ||
      standard_strategy_enabled !== undefined ||
      high_risk_strategy_enabled !== undefined ||
      repeated_trade_enabled !== undefined ||
      trade_execution_enabled !== undefined ||
      exchange_failure_enabled !== undefined
    ) {
      await updateExtendedAlarmPreferences(user.id, {
        duration,
        ringtone,
        master_enabled,
        standard_strategy_enabled,
        high_risk_strategy_enabled,
        repeated_trade_enabled,
        trade_execution_enabled,
        exchange_failure_enabled,
      });
    }

    return NextResponse.json({ data: await getMergedPreferences(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification preferences could not be saved.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
