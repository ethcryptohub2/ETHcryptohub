import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../../lib/auth';
import { getSignalHistoryDetail, recordUserSignalTrade } from '../../../../lib/signal-history';
import { validCsrf } from '../../../../lib/http';
import { requirePremiumUser, SubscriptionError } from '../../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requirePremiumUser();
    const { id } = await params;
    if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'Signal not found.' }, { status: 404 });
    const result = await getSignalHistoryDetail(id, user.id);
    if (!result) return NextResponse.json({ error: 'Signal not found.' }, { status: 404 });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Signal detail is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

const priceSchema = z.string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/)
  .refine((value) => Number(value) > 0);

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    const { id } = await params;
    if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'Signal not found.' }, { status: 404 });
    const body: unknown = await request.json().catch(() => null);
    const parsed = z.object({
      entryPrice: priceSchema.optional(),
      exitPrice: priceSchema.optional(),
    }).strict().refine((value) => value.entryPrice !== undefined || value.exitPrice !== undefined).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Provide a valid user-reported entry or exit price.' }, { status: 422 });
    const data = await recordUserSignalTrade(user.id, id, parsed.data.entryPrice, parsed.data.exitPrice);
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 422;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'User-reported trade could not be saved.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
