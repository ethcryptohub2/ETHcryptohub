import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { BinanceFuturesError, isTradingEnvironment, testBinanceEnvironment, type TradingEnvironment } from '../../../lib/binance-futures';
import { encryptCredential } from '../../../lib/binance-credentials';
import { query } from '../../../lib/db';
import { validCsrf } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Credentials = { api_key_ciphertext: string; api_secret_ciphertext: string; updated_at: string };
const requestSchema = z.object({
  action: z.enum(['save', 'remove', 'test']),
  environment: z.enum(['DEMO', 'LIVE']),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
}).strict();

async function credentials(userId: number, environment: TradingEnvironment) {
  return query<Credentials>(
    'SELECT api_key_ciphertext, api_secret_ciphertext, updated_at FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2',
    [userId, environment],
  );
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const requested = request.nextUrl.searchParams.get('environment') ?? 'DEMO';
    if (!isTradingEnvironment(requested)) return NextResponse.json({ error: 'Invalid Binance environment.' }, { status: 422 });
    const result = await credentials(user.id, requested);
    return NextResponse.json({
      data: {
        environment: requested,
        configured: Boolean(result.rows[0]),
        updatedAt: result.rows[0]?.updated_at ?? null,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Binance settings unavailable.' }, { status });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid Binance credential request.' }, { status: 422 });
    const { action, environment } = parsed.data;

    if (action === 'remove') {
      await query('DELETE FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2', [user.id, environment]);
      return NextResponse.json({ data: { environment, configured: false } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === 'save') {
      const { apiKey, apiSecret } = parsed.data;
      if (
        typeof apiKey !== 'string' || typeof apiSecret !== 'string' ||
        !/^[A-Za-z0-9]{20,128}$/.test(apiKey.trim()) ||
        !/^[A-Za-z0-9]{20,128}$/.test(apiSecret.trim())
      ) {
        return NextResponse.json({ error: 'Enter valid Binance API key and secret values.' }, { status: 422 });
      }
      const apiKeyCiphertext = encryptCredential(apiKey.trim());
      const apiSecretCiphertext = encryptCredential(apiSecret.trim());
      await query(
        `INSERT INTO public.binance_api_credentials (user_id, environment, api_key_ciphertext, api_secret_ciphertext, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, environment) DO UPDATE SET
           api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
           updated_at = NOW()`,
        [user.id, environment, apiKeyCiphertext, apiSecretCiphertext],
      );
      return NextResponse.json({ data: { environment, configured: true } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const result = await testBinanceEnvironment(user.id, environment);
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BinanceFuturesError ? error.status : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Binance request failed.',
    }, { status });
  }
}
