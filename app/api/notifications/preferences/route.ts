import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import { getNotificationPreferences, updateNotificationPreferences } from '../../../../lib/notifications';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
}).strict();

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ data: await getNotificationPreferences(user.id) }, {
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
    await updateNotificationPreferences(user.id, parsed.data);
    return NextResponse.json({ data: await getNotificationPreferences(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification preferences could not be saved.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
