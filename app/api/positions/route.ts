import { AuthError } from '../../../lib/auth';
import { getPaperTradingSummary, listUserSignalEntries } from '../../../lib/signal-history';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { user } = await requirePremiumUser({ reconcile: false });
    const [positions, summary] = await Promise.all([
      listUserSignalEntries(user.id),
      getPaperTradingSummary(user.id),
    ]);
    return Response.json({
      data: {
        positions,
        summary,
      },
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Recorded positions are unavailable.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}
