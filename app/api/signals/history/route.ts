import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '../../../../lib/auth';
import { listSignalHistory } from '../../../../lib/signal-history';
import { requirePremiumUser, SubscriptionError } from '../../../../lib/subscriptions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  scannerType: z.enum(['STANDARD', 'HIGH_RISK']).optional(),
  side: z.enum(['LONG', 'SHORT']).optional(),
  timeframe: z.enum(['1m', '3m', '5m', '15m', '1h', '4h']).optional(),
  status: z.enum(['ACTIVE', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED', 'STOP_LOSS_HIT', 'EXPIRED', 'ENTRY_INVALIDATED', 'MISSED', 'AMBIGUOUS']).optional(),
  symbol: z.string().trim().max(30).optional(),
  strategy: z.string().trim().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  successful: z.enum(['true', 'false']).optional(),
}).strict();

export async function GET(request: NextRequest) {
  try {
    await requirePremiumUser();
    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid signal history filters.' }, { status: 422 });
    const { successful, ...filters } = parsed.data;
    const result = await listSignalHistory({
      ...filters,
      successful: successful === 'true',
    });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Signal history is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
