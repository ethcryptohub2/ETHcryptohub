import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requireUser } from '../../../../lib/auth';
import { getScalpingPushPreference, setScalpingPushPreference } from '../../../../lib/high-risk-scalping';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ data: { pushEnabled: await getScalpingPushPreference(user.id) } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Scalping preferences are unavailable.' }, { status });
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = z.object({ pushEnabled: z.boolean() }).strict().safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scalping notification preference.' }, { status: 422 });
    await setScalpingPushPreference(user.id, parsed.data.pushEnabled);
    return NextResponse.json({ data: { pushEnabled: parsed.data.pushEnabled } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 422;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save scalping preference.' }, { status });
  }
}
