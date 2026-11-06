import { NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { getSubscriptionHistory } from '../../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ data: await getSubscriptionHistory(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError ? error.message : 'Subscription history is unavailable.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
