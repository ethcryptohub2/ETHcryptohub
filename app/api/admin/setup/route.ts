import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '../../../../lib/db';
import { validCsrf } from '../../../../lib/http';
import { currentUser } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await pool().query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM public.users WHERE role = 'admin') AS exists");
    return NextResponse.json({ data: { setupAvailable: !result.rows[0]?.exists } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Admin setup is unavailable until the database is configured.' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'A verified signed-in account is required.' }, { status: 401 });
  const setupSecret = process.env.ADMIN_SETUP_TOKEN ?? '';
  if (setupSecret.length < 32) return NextResponse.json({ error: 'One-time administrator setup is not configured.' }, { status: 404 });
  let body: { setupToken?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 }); }
  if (typeof body.setupToken !== 'string') return NextResponse.json({ error: 'Setup authorization failed.' }, { status: 403 });
  const submitted = Buffer.from(body.setupToken);
  const expected = Buffer.from(setupSecret);
  if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) {
    return NextResponse.json({ error: 'Setup authorization failed.' }, { status: 403 });
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [728390114]);
    const existingAdmin = await client.query("SELECT id FROM public.users WHERE role = 'admin' LIMIT 1");
    if (existingAdmin.rowCount) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Initial administrator setup is already complete.' }, { status: 410 });
    }
    const promoted = await client.query(
      `UPDATE public.users
          SET role = 'admin'
        WHERE id = $1 AND is_active = 1 AND is_email_verified = 1
          AND supabase_user_id IS NOT NULL
        RETURNING id`,
      [user.id],
    );
    if (!promoted.rowCount) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'The signed-in verified account could not be promoted.' }, { status: 403 });
    }
    await client.query('COMMIT');
    return NextResponse.json({ data: { configured: true } }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Initial administrator setup failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Administrator setup failed.' }, { status: 503 });
  } finally { client.release(); }
}
