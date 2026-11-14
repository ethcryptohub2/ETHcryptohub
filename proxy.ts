import { NextRequest, NextResponse } from 'next/server';
import { decideUiPreviewRequest, UI_PREVIEW_UNAVAILABLE_PATH } from './lib/ui-preview-mode.mjs';

export function proxy(request: NextRequest) {
  const decision = decideUiPreviewRequest(
    process.env,
    request.nextUrl.pathname,
    request.method,
  );

  if (decision === 'next') return NextResponse.next();
  if (decision === 'unavailable') {
    const destination = request.nextUrl.clone();
    destination.pathname = UI_PREVIEW_UNAVAILABLE_PATH;
    destination.search = '';
    return NextResponse.rewrite(destination);
  }
  return NextResponse.json(
    { error: 'Unavailable in UI Preview.' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
