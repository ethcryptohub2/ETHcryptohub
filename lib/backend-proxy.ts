import { NextRequest, NextResponse } from 'next/server';

export function resolveBackendBaseUrl(): string | null {
  const raw = process.env.SMARTEXIT_BACKEND_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function shouldForwardToBackend(): boolean {
  const backend = resolveBackendBaseUrl();
  if (!backend) return false;
  // Never create a proxy loop on the dedicated backend container itself
  if (process.env.SCANNER_CIRCUIT_BREAKER_SCOPE?.trim().toLowerCase() === 'northflank') {
    return false;
  }
  return process.env.VERCEL === '1' || process.env.SMARTEXIT_FORCE_BACKEND_PROXY === 'true';
}

export async function forwardRequestToBackend(
  request: NextRequest,
  pathnameWithQuery: string,
  options: { method?: 'GET' | 'POST'; bodyText?: string; timeoutMs?: number } = {},
): Promise<NextResponse | null> {
  const baseUrl = resolveBackendBaseUrl();
  if (!baseUrl) return null;

  const targetUrl = `${baseUrl}${pathnameWithQuery}`;
  const headers = new Headers();
  const cookie = request.headers.get('cookie');
  const csrfToken = request.headers.get('x-csrf-token');
  const contentType = request.headers.get('content-type');
  if (cookie) headers.set('cookie', cookie);
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  if (contentType) headers.set('content-type', contentType);
  headers.set('origin', baseUrl);

  const response = await fetch(targetUrl, {
    method: options.method ?? request.method,
    headers,
    ...(options.bodyText !== undefined ? { body: options.bodyText } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 28_000),
    cache: 'no-store',
  });

  const payload = await response.text();
  return new NextResponse(payload, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
