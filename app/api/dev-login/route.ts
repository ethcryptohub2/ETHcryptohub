import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const host = request.headers.get('host') || '';
  const isLocalOrStaging =
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    host.includes('onrender.com');

  if (!isLocalOrStaging) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Create active session for admin user (ID 2)
  await createSession(2);

  const redirectUrl = new URL('/admin/trade-performance', request.url);
  return NextResponse.redirect(redirectUrl);
}
