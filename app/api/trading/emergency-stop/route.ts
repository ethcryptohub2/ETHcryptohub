import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import { activateKillSwitch, resetKillSwitch } from '../../../../lib/trading-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  environment: z.enum(['DEMO', 'LIVE']),
  action: z.enum(['STOP', 'RESET']).default('STOP'),
  confirmReset: z.literal(true).optional(),
}).strict();

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Select an environment for the emergency stop.' }, { status: 422 });
    if (parsed.data.action === 'RESET' && parsed.data.confirmReset !== true) {
      return Response.json({ error: 'Explicit confirmation is required to reset this environment’s emergency stop.' }, { status: 422 });
    }
    const data = parsed.data.action === 'STOP'
      ? await activateKillSwitch(user.id, parsed.data.environment)
      : await resetKillSwitch(user.id, parsed.data.environment);
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'Emergency stop could not be enabled.' }, { status });
  }
}
