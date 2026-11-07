import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { validCsrf } from '../../../lib/http';
import { getUnreadNewsCount, getPublishedNews, markNewsNotificationsRead } from '../../../lib/news-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  category: z.string().regex(/^[a-z]{2,40}$/).optional(),
  ticker: z.string().regex(/^[A-Z0-9]{2,12}$/).optional(),
  sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL', 'UNAVAILABLE']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'BREAKING']).optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return Response.json({ error: 'Invalid news filters.' }, { status: 422 });
    const data = await getPublishedNews({ ...parsed.data, userId: user.id });
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'News feed is unavailable.' }, { status });
  }
}

export async function PATCH(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = z.object({
      action: z.literal('mark_read'),
      ids: z.array(z.string().regex(/^\d{1,20}$/)).max(100).optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid news notification update.' }, { status: 422 });
    await markNewsNotificationsRead(user.id, parsed.data.ids);
    return Response.json(
      { data: { unreadCount: await getUnreadNewsCount(user.id) } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'News notifications could not be updated.' }, { status });
  }
}
