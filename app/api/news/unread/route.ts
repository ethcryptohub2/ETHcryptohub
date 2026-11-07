import { AuthError, requireUser } from '../../../../lib/auth';
import { getUnreadNewsCount } from '../../../../lib/news-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ data: { unreadCount: await getUnreadNewsCount(user.id) } }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'News notification count is unavailable.' },
      { status: error instanceof AuthError ? error.status : 503 },
    );
  }
}
