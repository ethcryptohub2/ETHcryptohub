import type { NextRequest } from 'next/server';
import { getApprovedScannerPilot, runStagingScannerPilot } from '../../../../lib/staging-scanner-pilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function reply(data: object, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const authorization = request.headers.get('authorization');
  const credentials = { hostname: request.nextUrl.hostname, expectedSha: request.headers.get('x-smartexit-expected-commit'),
    token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : null };
  const approval = getApprovedScannerPilot(process.env, credentials);
  if (!approval || request.body !== null || request.nextUrl.search) return reply({ state: 'UNAVAILABLE' }, 404);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(26_000)]);
  try {
    const result = await runStagingScannerPilot(approval, signal, () => Boolean(getApprovedScannerPilot(process.env, credentials)));
    return reply(result, ['COMPLETED', 'DUPLICATE'].includes(result.state) ? 200 : result.state === 'BUSY' ? 409 : 503);
  } catch {
    return reply({ state: 'UNAVAILABLE' }, 503);
  }
}
