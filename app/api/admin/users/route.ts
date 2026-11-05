import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { query } from '../../../../lib/db';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireAdmin();
    const [metrics, users] = await Promise.all([
      query<{ total: string; verified: string; x_verified: string; inactive: string }>(
        `SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE is_email_verified = 1) AS verified,
          COUNT(*) FILTER (WHERE is_x_verified = 1) AS x_verified,
          COUNT(*) FILTER (WHERE is_active = 0) AS inactive FROM public.users`,
      ),
      query(
        `SELECT id, email, full_name, country_code, phone_number, x_handle, is_x_verified,
          is_email_verified, is_active, role, created_at FROM public.users ORDER BY created_at DESC LIMIT 1000`,
      ),
    ]);
    return NextResponse.json({ data: { metrics: metrics.rows[0], users: users.rows } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'Admin data unavailable.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const admin = await requireAdmin();
    const body = await request.json() as { action?: unknown; userId?: unknown };
    if (!Number.isSafeInteger(body.userId) || Number(body.userId) < 1 || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'Invalid user action.' }, { status: 400 });
    }
    const target = Number(body.userId);
    if (target === admin.id && ['toggle_active', 'delete_user'].includes(body.action)) {
      return NextResponse.json({ error: 'You cannot suspend or delete your own administrator account.' }, { status: 400 });
    }
    let result;
    if (body.action === 'toggle_x_verification') {
      result = await query('UPDATE public.users SET is_x_verified = 1 - is_x_verified WHERE id = $1', [target]);
    } else if (body.action === 'toggle_active') {
      result = await query('UPDATE public.users SET is_active = 1 - is_active WHERE id = $1 AND id <> $2', [target, admin.id]);
    } else if (body.action === 'delete_user') {
      result = await query('DELETE FROM public.users WHERE id = $1 AND id <> $2', [target, admin.id]);
    } else {
      return NextResponse.json({ error: 'Unsupported user action.' }, { status: 400 });
    }
    if (!result || result.rowCount !== 1) return NextResponse.json({ error: 'No matching user was changed.' }, { status: 404 });
    return NextResponse.json({ data: { updated: true } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'User action failed.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}
