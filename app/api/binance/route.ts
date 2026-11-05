import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { decryptCredential, encryptCredential } from '../../../lib/binance-credentials';
import { query } from '../../../lib/db';
import { validCsrf } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Credentials = { api_key_ciphertext: string; api_secret_ciphertext: string; updated_at: string };
async function credentials(userId: number) {
  return query<Credentials>('SELECT api_key_ciphertext, api_secret_ciphertext, updated_at FROM public.binance_api_credentials WHERE user_id = $1', [userId]);
}

export async function GET() {
  try {
    const user = await requireUser();
    const result = await credentials(user.id);
    return NextResponse.json({ data: { configured: Boolean(result.rows[0]), updatedAt: result.rows[0]?.updated_at ?? null } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : 'Binance settings unavailable.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body = await request.json() as { action?: unknown; apiKey?: unknown; apiSecret?: unknown };
    if (body.action === 'remove') {
      await query('DELETE FROM public.binance_api_credentials WHERE user_id = $1', [user.id]);
      return NextResponse.json({ data: { configured: false } });
    }
    if (body.action === 'save') {
      if (typeof body.apiKey !== 'string' || typeof body.apiSecret !== 'string' ||
          !/^[A-Za-z0-9]{20,128}$/.test(body.apiKey.trim()) || !/^[A-Za-z0-9]{20,128}$/.test(body.apiSecret.trim())) {
        return NextResponse.json({ error: 'Enter valid Binance API key and secret values.' }, { status: 422 });
      }
      const apiKey = encryptCredential(body.apiKey.trim());
      const apiSecret = encryptCredential(body.apiSecret.trim());
      await query(
        `INSERT INTO public.binance_api_credentials (user_id, api_key_ciphertext, api_secret_ciphertext, updated_at)
         VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id) DO UPDATE SET
         api_key_ciphertext = EXCLUDED.api_key_ciphertext, api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
         updated_at = NOW()`,
        [user.id, apiKey, apiSecret],
      );
      return NextResponse.json({ data: { configured: true } });
    }
    if (body.action === 'test') {
      const result = await credentials(user.id);
      if (!result.rows[0]) return NextResponse.json({ error: 'Save Binance credentials first.' }, { status: 400 });
      const { api_key_ciphertext, api_secret_ciphertext } = result.rows[0];
      const apiKey = decryptCredential(api_key_ciphertext);
      const apiSecret = decryptCredential(api_secret_ciphertext);
      const params = new URLSearchParams({ recvWindow: '5000', timestamp: Date.now().toString() });
      const signature = createHmac('sha256', apiSecret).update(params.toString()).digest('hex');
      const response = await fetch(`https://fapi.binance.com/fapi/v3/account?${params}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return NextResponse.json({ error: 'Binance rejected the account check. Verify Futures read permission and server time.' }, { status: 502 });
      return NextResponse.json({ data: { connected: true, ordersPlaced: false } });
    }
    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof AuthError ? error.message : error instanceof Error ? error.message : 'Binance request failed.' }, { status: error instanceof AuthError ? error.status : 503 });
  }
}
