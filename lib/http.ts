import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

export function isValidIp(value: string): boolean {
  const trimmed = value.trim();
  if (IPV4_PATTERN.test(trimmed)) return true;
  if (trimmed.includes(':') && /^[0-9a-fA-F:]{2,45}$/.test(trimmed)) {
    return !trimmed.includes(':::') && trimmed.split(':').length <= 8;
  }
  return false;
}

export function resolveClientIp(request: NextRequest): string | null {
  const vercelIp = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  if (vercelIp && isValidIp(vercelIp)) return vercelIp;

  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp && isValidIp(cfIp)) return cfIp;

  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwardedFor && isValidIp(forwardedFor)) return forwardedFor;

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp && isValidIp(realIp)) return realIp;

  if ('ip' in request && typeof (request as { ip?: unknown }).ip === 'string') {
    const rawIp = (request as { ip: string }).ip.trim();
    if (isValidIp(rawIp)) return rawIp;
  }

  return null;
}

function extractHostFromUrl(urlValue: string | undefined): string | null {
  if (!urlValue?.trim()) return null;
  try {
    const parsed = new URL(urlValue.trim().startsWith('http') ? urlValue.trim() : `https://${urlValue.trim()}`);
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

export function isTrustedDeploymentHost(candidateHost: string, env: Record<string, string | undefined> = process.env): boolean {
  const normalizedCandidate = candidateHost.trim().toLowerCase();
  if (!normalizedCandidate || normalizedCandidate.includes('/') || normalizedCandidate.includes(' ')) return false;

  const trustedHostPatterns: Array<string | null> = [
    extractHostFromUrl(env.APP_URL),
    extractHostFromUrl(env.RENDER_EXTERNAL_URL),
    extractHostFromUrl(env.SMARTEXIT_STAGING_PREVIEW_URL),
    extractHostFromUrl(env.SMARTEXIT_PRODUCTION_APP_URL),
    extractHostFromUrl(env.VERCEL_PROJECT_PRODUCTION_URL),
    extractHostFromUrl(env.VERCEL_BRANCH_URL),
    extractHostFromUrl(env.VERCEL_URL),
  ];

  for (const trusted of trustedHostPatterns) {
    if (trusted && (normalizedCandidate === trusted || normalizedCandidate === `${trusted}:443` || normalizedCandidate === `${trusted}:80`)) {
      return true;
    }
  }

  // Preview wildcard matching (*.vercel.app for trusted deployment scope)
  if (env.VERCEL_ENV === 'preview' && normalizedCandidate.endsWith('.vercel.app')) {
    const sub = normalizedCandidate.slice(0, -'.vercel.app'.length);
    if (/^[a-z0-9-]+$/i.test(sub)) return true;
  }

  // Render Staging wildcard matching (*.onrender.com for trusted staging scope)
  if ((env.RENDER || env.SMARTEXIT_DEPLOYMENT_ENV === 'staging') && normalizedCandidate.endsWith('.onrender.com')) {
    const sub = normalizedCandidate.slice(0, -'.onrender.com'.length);
    if (/^[a-z0-9-]+$/i.test(sub)) return true;
  }

  // Local/test fixture boundary
  const isLocalOrTest = !env.VERCEL_ENV || env.VERCEL_ENV === 'development' || env.NODE_ENV !== 'production';
  if (isLocalOrTest) {
    const hostWithoutPort = normalizedCandidate.replace(/:\d+$/, '');
    if (['localhost', '127.0.0.1', '::1', 'preview.example', 'staging.example'].includes(hostWithoutPort)) {
      return true;
    }
  }

  return false;
}

export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin')?.trim();
  const host = request.headers.get('host')?.trim();
  if (!origin || !host) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
    if (originUrl.origin !== origin) return false;
  } catch {
    return false;
  }

  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
    ? forwardedProtocol
    : request.nextUrl?.protocol ? request.nextUrl.protocol.replace(':', '') : 'https';

  // 1. Direct host match
  try {
    const directOrigin = new URL(`${protocol}://${host}`).origin;
    if (directOrigin === originUrl.origin) return true;
  } catch {
    // continue
  }

  // 2. Next.js trusted nextUrl origin match
  if (request.nextUrl && request.nextUrl.origin === originUrl.origin) {
    return true;
  }

  // 3. Forwarded host handling with strict deployment boundary validation
  const rawForwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (rawForwardedHost && isTrustedDeploymentHost(rawForwardedHost)) {
    try {
      const forwardedOrigin = new URL(`${protocol}://${rawForwardedHost}`).origin;
      if (forwardedOrigin === originUrl.origin) return true;
    } catch {
      // continue
    }
  }

  return false;
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

