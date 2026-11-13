import { NextRequest, NextResponse } from 'next/server';
import {
  decideUiPreviewRequest,
  isUiPreviewRequested,
  UI_PREVIEW_UNAVAILABLE_PATH,
} from './lib/ui-preview-mode.mjs';
import { createSupabaseRequestClient, hasSupabaseAuthCookie } from './lib/supabase-auth';

export async function proxy(request: NextRequest) {
  const decision = decideUiPreviewRequest(
    process.env,
    request.nextUrl.pathname,
    request.method,
  );

  if (decision === 'unavailable') {
    const destination = request.nextUrl.clone();
    destination.pathname = UI_PREVIEW_UNAVAILABLE_PATH;
    destination.search = '';
    return NextResponse.rewrite(destination);
  }
  if (decision === 'reject') {
    return NextResponse.json(
      { error: 'Unavailable in UI Preview.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (isUiPreviewRequested(process.env) || !hasSupabaseAuthCookie(request.cookies)) {
    return NextResponse.next({ request });
  }

  const { client, applyCookies } = createSupabaseRequestClient(request);
  const { error } = await client.auth.getUser();
  if (error && (!error.status || error.status >= 500)) {
    return applyCookies(NextResponse.json(
      { error: 'Authentication is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    ));
  }
  return applyCookies(NextResponse.next({ request }));
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
