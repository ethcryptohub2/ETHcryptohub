import type { NextRequest } from 'next/server';
import { authRoute } from '../../../../lib/auth-routes';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (action !== 'me') return Response.json({ error: 'Not found.' }, { status: 404 });
  return authRoute(action, request);
}

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  return authRoute(action, request);
}
