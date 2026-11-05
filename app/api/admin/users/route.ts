import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { pool, query } from '../../../../lib/db';
import { validCsrf } from '../../../../lib/http';
import { z } from 'zod';

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
    const parsed = z.object({
      action: z.enum(['toggle_x_verification', 'toggle_active', 'delete_user', 'mark_email_verified']),
      userId: z.number().int().positive().safe(),
    }).safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid user action.' }, { status: 400 });
    }
    const { action, userId: target } = parsed.data;
    if (target === admin.id && ['toggle_active', 'delete_user', 'mark_email_verified'].includes(action)) {
      return NextResponse.json({ error: 'You cannot suspend, delete, or change verification for your own administrator account.' }, { status: 400 });
    }
    let result;
    if (action === 'toggle_x_verification') {
      result = await query('UPDATE public.users SET is_x_verified = 1 - is_x_verified WHERE id = $1', [target]);
    } else if (action === 'toggle_active') {
      result = await query('UPDATE public.users SET is_active = 1 - is_active WHERE id = $1 AND id <> $2', [target, admin.id]);
    } else if (action === 'delete_user') {
      result = await query('DELETE FROM public.users WHERE id = $1 AND id <> $2', [target, admin.id]);
    } else if (action === 'mark_email_verified') {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        result = await client.query(
          'UPDATE public.users SET is_email_verified = 1, email_verification_token = NULL WHERE id = $1 AND is_email_verified = 0',
          [target],
        );
        if (result.rowCount === 1) {
          await client.query('DELETE FROM public.email_verification_codes WHERE user_id = $1', [target]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      return NextResponse.json({ error: 'Unsupported user action.' }, { status: 400 });
    }
    if (!result || result.rowCount !== 1) return NextResponse.json({ error: 'No matching user was changed.' }, { status: 404 });
    return NextResponse.json({ data: { updated: true } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'User action failed.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}
