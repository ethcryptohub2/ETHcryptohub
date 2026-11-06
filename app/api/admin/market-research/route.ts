import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, AuthError } from '../../../../lib/auth';
import { encryptCredential } from '../../../../lib/binance-credentials';
import { query } from '../../../../lib/db';
import { validCsrf } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const providerSchema = z.enum(['glassnode', 'cryptopanic', 'coinglass']);

export async function GET() {
  try {
    await requireAdmin();
    const result = await query<{ provider: z.infer<typeof providerSchema>; updated_at: string }>(
      'SELECT provider, updated_at FROM public.market_research_credentials',
    );
    const configured = new Map(result.rows.map((row) => [row.provider, row.updated_at]));
    return NextResponse.json({
      data: Object.fromEntries(providerSchema.options.map((provider) => [
        provider,
        { configured: configured.has(provider), updatedAt: configured.get(provider) ?? null },
      ])),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof AuthError ? error.message : 'Market research settings unavailable. Apply the latest database migration.',
    }, { status: error instanceof AuthError ? error.status : 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    await requireAdmin();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid provider settings.' }, { status: 400 });
    }
    const parsed = z.object({
      provider: providerSchema,
      action: z.enum(['save', 'remove']),
      apiKey: z.string().max(512).optional(),
    }).safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid provider settings.' }, { status: 422 });
    const { provider, action, apiKey } = parsed.data;
    if (action === 'remove') {
      await query('DELETE FROM public.market_research_credentials WHERE provider = $1', [provider]);
      return NextResponse.json({ data: { configured: false } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const value = apiKey?.trim();
    if (!value || value.length < 8 || /[\r\n]/.test(value)) {
      return NextResponse.json({ error: 'Enter a valid API key (at least 8 characters, on one line).' }, { status: 422 });
    }
    const ciphertext = encryptCredential(value);
    await query(
      `INSERT INTO public.market_research_credentials (provider, api_key_ciphertext, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (provider) DO UPDATE SET api_key_ciphertext = EXCLUDED.api_key_ciphertext, updated_at = NOW()`,
      [provider, ciphertext],
    );
    return NextResponse.json({ data: { configured: true } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof AuthError
        ? error.message
        : error instanceof Error && error.message.includes('BINANCE_CREDENTIALS_KEY')
          ? 'Credential encryption is not configured. Set BINANCE_CREDENTIALS_KEY in the deployment environment.'
          : 'Market research settings could not be saved.',
    }, { status: error instanceof AuthError ? error.status : 503 });
  }
}
