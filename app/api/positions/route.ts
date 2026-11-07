import { AuthError } from '../../../lib/auth';
import { listUserSignalEntries } from '../../../lib/signal-history';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { user } = await requirePremiumUser();
    return Response.json({ data: await listUserSignalEntries(user.id) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Recorded positions are unavailable.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}
