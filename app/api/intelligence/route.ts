import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { guardedPost } from '../../../lib/http';
import { readIntelligenceStatus } from '../../../lib/intelligence/server-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    if (request.nextUrl.search) return json({ error: 'Account selection and query overrides are not supported.' }, 422);
    return json({ data: await readIntelligenceStatus(user) });
  } catch (error) {
    return json({ error: error instanceof AuthError ? error.message : 'Research status is unavailable.' }, error instanceof AuthError ? error.status : 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const rejected = guardedPost(request);
    if (rejected) return rejected;
    // No body field or feature flag can activate execution in this release.
    return json({ error: 'Remote paper settings and execution are not activated.', code: 'PAPER_FOUNDATION_INACTIVE' }, 503);
  } catch (error) {
    return json({ error: error instanceof AuthError ? error.message : 'Paper settings are unavailable.' }, error instanceof AuthError ? error.status : 503);
  }
}
