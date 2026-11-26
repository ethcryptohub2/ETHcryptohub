import { NextRequest, NextResponse } from 'next/server';
import { resolveBackendBaseUrl, shouldForwardToBackend } from './backend-target';

export { resolveBackendBaseUrl, shouldForwardToBackend };

export async function forwardRequestToBackend(
  request: NextRequest,
  pathnameWithQuery: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; bodyText?: string; timeoutMs?: number } = {},
): Promise<NextResponse | null> {
  const baseUrl = resolveBackendBaseUrl();
  if (!baseUrl) return null;

  const targetUrl = `${baseUrl}${pathnameWithQuery}`;
  const headers = new Headers();
  const cookie = request.headers?.get?.('cookie');
  const csrfToken = request.headers?.get?.('x-csrf-token');
  const contentType = request.headers?.get?.('content-type');
  if (cookie) headers.set('cookie', cookie);
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  if (contentType) headers.set('content-type', contentType);
  headers.set('origin', baseUrl);

  const method = options.method ?? request.method;
  const response = await fetch(targetUrl, {
    method,
    headers,
    ...(options.bodyText !== undefined && method !== 'GET' ? { body: options.bodyText } : {}),
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
