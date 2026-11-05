import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { query } from '../../../lib/db';
import { validCsrf } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ data: user }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'Sign in required.' }, { status: error instanceof AuthError ? error.status : 401 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body = await request.json() as { xHandle?: unknown };
    if (typeof body.xHandle !== 'string') return NextResponse.json({ error: 'Enter a valid X handle.' }, { status: 422 });
    const handle = body.xHandle.trim().replace(/^@+/, '');
    if (handle.length > 15 || (handle !== '' && !/^[A-Za-z0-9_]+$/.test(handle))) {
      return NextResponse.json({ error: 'Use at most 15 letters, numbers, or underscores.' }, { status: 422 });
    }
    await query('UPDATE public.users SET x_handle = NULLIF($1, \'\') WHERE id = $2', [handle, user.id]);
    return NextResponse.json({ data: { xHandle: handle || null } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'Settings could not be saved.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}
