import { NextRequest, NextResponse } from 'next/server';
import { csrfToken } from '../../../lib/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const existing = request.cookies.get('ethcryptohub_csrf')?.value;
  const token = existing && /^[a-f0-9]{64}$/.test(existing) ? existing : csrfToken();
  const response = NextResponse.json({ data: { csrfToken: token } }, { headers: { 'Cache-Control': 'no-store' } });
  if (existing !== token) {
    response.cookies.set('ethcryptohub_csrf', token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
  }
  return response;
}
