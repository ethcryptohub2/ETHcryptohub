import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../lib/auth';
import {
  listHighRiskScalpingSignals,
  markScalpingSignalEntered,
} from '../../../lib/high-risk-scalping';
import { validCsrf } from '../../../lib/http';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { user } = await requirePremiumUser();
    return NextResponse.json({ data: await listHighRiskScalpingSignals(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'High-risk scalping data is unavailable.',
      ...(error instanceof SubscriptionError ? { code: error.code } : {}),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid scalping action.' }, { status: 400 }); }
    const parsed = z.object({ action: z.literal('mark_entered'), signalId: z.string().regex(/^\d{1,20}$/) }).strict().safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid scalping action.' }, { status: 422 });
    await markScalpingSignalEntered(user.id, parsed.data.signalId);
    return NextResponse.json({ data: { entered: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 422;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Could not update this entry state.',
      ...(error instanceof SubscriptionError ? { code: error.code } : {}),
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
