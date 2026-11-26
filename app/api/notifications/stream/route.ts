import { NextRequest } from 'next/server';
import { currentUser } from '../../../../lib/auth';
import { query } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = user.id;
  const encoder = new TextEncoder();
  let lastCheckedTime = new Date().toISOString();
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connected frame
      controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ userId, connectedAt: lastCheckedTime })}\n\n`));

      const interval = setInterval(async () => {
        if (isClosed) {
          clearInterval(interval);
          return;
        }

        try {
          // Check for notifications created since last checked
          const res = await query(
            `SELECT n.id, n.read_at, n.created_at, e.event_type, e.payload, s.id AS signal_id,
                    s.symbol, s.timeframe, s.side, s.setup_score, s.entry_price, s.initial_stop,
                    s.tp1, s.tp2, s.tp3, s.generated_at, s.expires_at, s.status, s.strategy_name,
                    s.scanner_type, s.repeated_scan_count
               FROM public.user_signal_notifications n
               JOIN public.signal_events e ON e.id = n.event_id
               JOIN public.market_signals s ON s.id = n.signal_id
              WHERE n.user_id = $1 AND n.created_at > $2::TIMESTAMPTZ
              ORDER BY n.created_at ASC LIMIT 20`,
            [userId, lastCheckedTime],
          );

          if (res.rows.length > 0) {
            lastCheckedTime = res.rows[res.rows.length - 1]!.created_at;
            for (const item of res.rows) {
              controller.enqueue(encoder.encode(`event: notification\ndata: ${JSON.stringify(item)}\n\n`));
            }
          } else {
            // Heartbeat comment
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }
        } catch {
          // Ignore transient query errors during SSE poll
        }
      }, 3000);

      request.signal.addEventListener('abort', () => {
        isClosed = true;
        clearInterval(interval);
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      isClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
