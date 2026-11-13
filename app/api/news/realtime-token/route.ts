export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { error: 'Realtime token issuance is disabled; use authenticated news API polling.' },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
