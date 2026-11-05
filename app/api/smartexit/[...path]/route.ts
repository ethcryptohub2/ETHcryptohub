import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function forward(request: NextRequest, pathParts: string[]) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'AUTH_REQUIRED', message: error instanceof AuthError ? error.message : 'Sign in required.' } },
      { status: error instanceof AuthError ? error.status : 401 },
    );
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !validCsrf(request)) {
    return NextResponse.json({ error: { code: 'CSRF_VALIDATION_FAILED', message: 'Refresh and retry.' } }, { status: 403 });
  }
  const apiBase = process.env.SMARTEXIT_API_URL?.trim();
  const secret = process.env.SMARTEXIT_BRIDGE_SECRET ?? '';
  if (!apiBase || secret.length < 32) {
    return NextResponse.json(
      { error: { code: 'SMARTEXIT_UNAVAILABLE', message: 'SmartExit API is not configured on this deployment.' } },
      { status: 503 },
    );
  }

  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    return NextResponse.json({ error: { code: 'SMARTEXIT_UNAVAILABLE', message: 'SmartExit API URL is invalid.' } }, { status: 503 });
  }
  const apiHost = base.hostname.toLowerCase();
  const isLoopback = apiHost === '127.0.0.1' || apiHost === 'localhost';
  const isRailwayPrivate = apiHost.endsWith('.railway.internal');
  const isLocalHttp = base.protocol === 'http:' && (isLoopback || isRailwayPrivate);
  const isPublicHttps = base.protocol === 'https:' && !isLoopback && !isRailwayPrivate && apiHost.includes('.');
  if ((!isLocalHttp && !isPublicHttps) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    return NextResponse.json(
      { error: { code: 'SMARTEXIT_UNAVAILABLE', message: 'SmartExit API must use HTTPS, except for local or private Railway development origins.' } },
      { status: 503 },
    );
  }

  const targetPath = `/api/${pathParts.join('/')}`;
  if (pathParts.length === 0 || pathParts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
    return NextResponse.json({ error: { code: 'INVALID_API_PATH', message: 'Invalid SmartExit path.' } }, { status: 400 });
  }
  const query = request.nextUrl.search;
  const target = `${targetPath}${query}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${user.id}\n${timestamp}\n${request.method.toUpperCase()}\n${target}`)
    .digest('hex');
  const headers = new Headers({ Accept: 'application/json' });
  headers.set('X-Ethcryptohub-User', String(user.id));
  headers.set('X-Ethcryptohub-Timestamp', timestamp);
  headers.set('X-Ethcryptohub-Signature', signature);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);

  try {
    const upstream = await fetch(new URL(target, base), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(55_000),
    });
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json(
      { error: { code: 'SMARTEXIT_UNAVAILABLE', message: 'Could not reach the SmartExit private API.' } },
      { status: 502 },
    );
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };
export async function GET(request: NextRequest, { params }: RouteContext) { return forward(request, (await params).path); }
export async function POST(request: NextRequest, { params }: RouteContext) { return forward(request, (await params).path); }
export async function PUT(request: NextRequest, { params }: RouteContext) { return forward(request, (await params).path); }
export async function DELETE(request: NextRequest, { params }: RouteContext) { return forward(request, (await params).path); }
