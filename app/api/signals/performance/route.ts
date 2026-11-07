import { NextResponse } from 'next/server';
import { AuthError } from '../../../../lib/auth';
import { getSignalPerformanceSummary } from '../../../../lib/signal-history';
import { requirePremiumUser, SubscriptionError } from '../../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requirePremiumUser();
    return NextResponse.json({ data: await getSignalPerformanceSummary() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Signal performance is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
