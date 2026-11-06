import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import {
  getNotificationAdminStats,
  getNotificationSystemSettings,
  updateGlobalNotificationSettings,
} from '../../../../lib/notifications';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const settingsSchema = z.object({
  enabled: z.boolean(),
  validityMinutes: z.object({
    '5m': z.number().int().min(1).max(1440),
    '15m': z.number().int().min(1).max(1440),
    '1h': z.number().int().min(1).max(1440),
    '4h': z.number().int().min(1).max(1440),
  }).strict(),
  minimumSetupScore: z.number().int().min(0).max(100),
  highConvictionScore: z.number().int().min(0).max(100),
  entryZoneAtrFraction: z.number().min(0.01).max(2),
}).strict();

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
    const parsed = z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
    }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid error log page.' }, { status: 422 });
    const [settings, stats] = await Promise.all([
      getNotificationSystemSettings(),
      getNotificationAdminStats(parsed.data.page),
    ]);
    return NextResponse.json({ data: { settings, stats } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification administration is unavailable.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    await requireAdmin();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid notification system settings.' }, { status: 400 }); }
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid notification system settings.' }, { status: 422 });
    await updateGlobalNotificationSettings(parsed.data);
    return NextResponse.json({ data: { settings: await getNotificationSystemSettings() } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Notification settings could not be saved.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
