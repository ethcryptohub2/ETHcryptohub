import { NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { createSupabaseRealtimeToken } from '../../../../lib/supabase-realtime-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(
      { data: createSupabaseRealtimeToken(user) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Realtime authentication is unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
