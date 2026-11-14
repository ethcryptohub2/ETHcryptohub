import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '../../../../lib/db';
import { validCsrf } from '../../../../lib/http';

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
  const setupSecret = process.env.ADMIN_SETUP_TOKEN ?? '';
  if (setupSecret.length < 32) return NextResponse.json({ error: 'One-time administrator setup is not configured.' }, { status: 404 });
  let body: { email?: unknown; password?: unknown; confirmation?: unknown; setupToken?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid form data.' }, { status: 400 }); }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255 ||
      typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') < 12 ||
      Buffer.byteLength(body.password, 'utf8') > 72 || typeof body.confirmation !== 'string' ||
      body.password !== body.confirmation || typeof body.setupToken !== 'string') {
    return NextResponse.json({ error: 'Check the email, password length (12–72 bytes), and confirmation.' }, { status: 422 });
  }
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
    const passwordHash = await bcrypt.hash(body.password, 12);
    const inserted = await client.query(
      `INSERT INTO public.users (email, password_hash, full_name, country_code, role, is_active, is_email_verified)
       VALUES ($1, $2, 'ETHcryptohub Administrator', '+91', 'admin', 1, 1)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, passwordHash],
    );
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 });
    }
    await client.query('COMMIT');
    return NextResponse.json({ data: { configured: true } }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Initial administrator setup failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Administrator setup failed.' }, { status: 503 });
  } finally { client.release(); }
}
