import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError } from '../../../lib/auth';
import { query } from '../../../lib/db';
import { validCsrf } from '../../../lib/http';
import { requirePremiumUser, SubscriptionError } from '../../../lib/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { user } = await requirePremiumUser({ reconcile: false });
    const [notifications, unread] = await Promise.all([
      query(
        `SELECT n.id, n.read_at, n.created_at, e.event_type, e.payload, s.id AS signal_id,
                s.symbol, s.timeframe, s.side, s.setup_score, s.entry_price, s.initial_stop,
                s.tp1, s.tp2, s.tp3, s.generated_at, s.expires_at, s.status, s.strategy_name,
                s.scanner_type, s.repeated_scan_count
           FROM public.user_signal_notifications n
           JOIN public.signal_events e ON e.id = n.event_id
           JOIN public.market_signals s ON s.id = n.signal_id
          WHERE n.user_id = $1
            AND (e.actor_user_id = n.user_id OR
              (e.actor_user_id IS NULL AND e.event_type NOT IN ('ENTRY_MARKED_AS_ENTERED', 'TRADE_CLOSED')))
          ORDER BY n.created_at DESC LIMIT 100`,
        [user.id],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
           FROM public.user_signal_notifications n
           JOIN public.signal_events e ON e.id = n.event_id
          WHERE n.user_id = $1 AND n.read_at IS NULL
            AND (e.actor_user_id = n.user_id OR
              (e.actor_user_id IS NULL AND e.event_type NOT IN ('ENTRY_MARKED_AS_ENTERED', 'TRADE_CLOSED')))`,
        [user.id],
      ),
    ]);
    return NextResponse.json({
      data: {
        notifications: notifications.rows,
        unreadCount: Number(unread.rows[0]?.count ?? 0),
        serverNow: new Date().toISOString(),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Notifications are unavailable.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid notification update.' }, { status: 400 }); }
    const parsedBody = z.object({
      action: z.enum(['mark_read', 'mark_all_read', 'clear_all']),
      id: z.coerce.number().int().positive().optional(),
    }).strict().safeParse(body);
    if (!parsedBody.success || (parsedBody.data.action === 'mark_read' && !parsedBody.data.id)) {
      return NextResponse.json({ error: 'Invalid notification update.' }, { status: 422 });
    }
    if (parsedBody.data.action === 'mark_all_read') {
      await query(
        'UPDATE public.user_signal_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
        [user.id],
      );
    } else if (parsedBody.data.action === 'clear_all') {
      await query(
        'DELETE FROM public.user_signal_notifications WHERE user_id = $1',
        [user.id],
      );
    } else {
      await query(
        'UPDATE public.user_signal_notifications SET read_at = NOW() WHERE user_id = $1 AND id = $2',
        [user.id, parsedBody.data.id],
      );
    }
    return NextResponse.json({ data: { updated: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Notification update failed.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const { user } = await requirePremiumUser();
    await query('DELETE FROM public.user_signal_notifications WHERE user_id = $1', [user.id]);
    return NextResponse.json({ data: { cleared: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AuthError || error instanceof SubscriptionError ? error.message : 'Failed to clear notifications.' },
      { status: error instanceof AuthError || error instanceof SubscriptionError ? error.status : 503 },
    );
  }
}
