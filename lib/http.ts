import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    if (originUrl.origin !== origin) return false;

    const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const protocol = forwardedProtocol || new URL(request.url).protocol.slice(0, -1);
    if (protocol !== 'http' && protocol !== 'https') return false;

    return new URL(`${protocol}://${host}`).origin === originUrl.origin;
  } catch {
    return false;
  }
}

export function csrfToken() {
  return randomBytes(32).toString('hex');
}

export function validCsrf(request: NextRequest) {
  const token = request.headers.get('x-csrf-token') ?? '';
  const cookie = request.cookies.get('ethcryptohub_csrf')?.value ?? '';
  const left = Buffer.from(token);
  const right = Buffer.from(cookie);
  return sameOrigin(request) && left.length === 64 && right.length === left.length && timingSafeEqual(left, right);
}

export function guardedPost(request: NextRequest) {
  return validCsrf(request) ? null : jsonError('Your security token expired. Refresh the page and retry.', 403);
}
