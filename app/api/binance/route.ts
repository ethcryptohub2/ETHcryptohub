import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { BinanceFuturesError, isTradingEnvironment, testBinanceEnvironment } from '../../../lib/binance-futures';
import { encryptCredential, isCredentialEncryptionConfigured } from '../../../lib/binance-credentials';
import { query } from '../../../lib/db';
import { validCsrf } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };
const blocked = {
  SCHEMA_BLOCKED: 'Binance credentials are unavailable until the database migration for credential environment confirmation is approved and applied.',
  ENCRYPTION_BLOCKED: 'Binance credentials are unavailable until an administrator verifies server-side encryption configuration.',
  ADMIN_APPROVAL_REQUIRED: 'Binance credential changes are disabled pending separate administrator approval.',
  SIGNED_READ_BLOCKED: 'Binance account verification is disabled pending separate provider-specific approval.',
} as const;
type BlockedCode = keyof typeof blocked;
const environmentSchema = z.enum(['DEMO', 'LIVE']);
const apiCredential = z.string().trim().regex(/^[A-Za-z0-9]{20,128}$/);
const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    environment: environmentSchema,
    apiKey: apiCredential,
    apiSecret: apiCredential,
    confirmCredentialEnvironment: z.literal(true),
  }).strict(),
  z.object({ action: z.literal('remove'), environment: environmentSchema }).strict(),
  z.object({ action: z.literal('test'), environment: environmentSchema }).strict(),
]);

async function storageBlock(): Promise<BlockedCode | undefined> {
  const readiness = await query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'binance_api_credentials'
          AND column_name = 'environment_confirmed' AND data_type = 'boolean'
     ) AS ready`,
  );
  if (!readiness.rows[0]?.ready) return 'SCHEMA_BLOCKED';
  if (!isCredentialEncryptionConfigured()) return 'ENCRYPTION_BLOCKED';
  if (process.env.SMARTEXIT_BINANCE_CREDENTIAL_STORAGE_ENABLED !== 'true') return 'ADMIN_APPROVAL_REQUIRED';
}

function blockedResponse(code: BlockedCode) {
  return NextResponse.json({ code, error: blocked[code] }, { status: 503, headers: noStore });
}

function errorResponse(reason: unknown) {
  if (reason instanceof AuthError) {
    return NextResponse.json({ error: reason.message }, { status: reason.status, headers: noStore });
  }
  if (reason && typeof reason === 'object' && 'code' in reason && (reason.code === '42P01' || reason.code === '42703')) {
    return blockedResponse('SCHEMA_BLOCKED');
  }
  if (reason instanceof BinanceFuturesError) {
    return NextResponse.json({ error: 'Binance account verification failed. Check the selected environment and key permissions.' }, {
      status: reason.status, headers: noStore,
    });
  }
  return NextResponse.json({ error: 'Binance credentials are currently unavailable. Try again later or contact an administrator.' }, {
    status: 503, headers: noStore,
  });
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const requested = request.nextUrl.searchParams.get('environment') ?? 'DEMO';
    if (!isTradingEnvironment(requested)) return NextResponse.json({ error: 'Invalid Binance environment.' }, { status: 422 });
    const reason = await storageBlock();
    if (reason) return blockedResponse(reason);
    const result = await query<{ environment_confirmed: boolean; updated_at: string }>(
      'SELECT environment_confirmed, updated_at FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2',
      [user.id, requested],
    );
    return NextResponse.json({
      data: {
        environment: requested,
        configured: result.rows[0]?.environment_confirmed === true,
        environmentConfirmationRequired: Boolean(result.rows[0] && !result.rows[0].environment_confirmed),
        updatedAt: result.rows[0]?.updated_at ?? null,
        signedReadEnabled: process.env.SMARTEXIT_BINANCE_CREDENTIAL_TESTS_ENABLED === 'true',
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return NextResponse.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid Binance credential request. Saving requires valid keys and explicit confirmation of their environment.' }, {
        status: 422, headers: noStore,
      });
    }
    const { action, environment } = parsed.data;
    const reason = await storageBlock();
    if (reason) return blockedResponse(reason);
    if (action === 'test' && process.env.SMARTEXIT_BINANCE_CREDENTIAL_TESTS_ENABLED !== 'true') {
      return blockedResponse('SIGNED_READ_BLOCKED');
    }

    if (action === 'remove') {
      await query('DELETE FROM public.binance_api_credentials WHERE user_id = $1 AND environment = $2', [user.id, environment]);
      return NextResponse.json({ data: { environment, configured: false } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === 'save') {
      const { apiKey, apiSecret } = parsed.data;
      const apiKeyCiphertext = encryptCredential(apiKey);
      const apiSecretCiphertext = encryptCredential(apiSecret);
      await query(
        `INSERT INTO public.binance_api_credentials (
           user_id, environment, api_key_ciphertext, api_secret_ciphertext,
           environment_confirmed, updated_at
         )
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (user_id, environment) DO UPDATE SET
           api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
           environment_confirmed = TRUE,
           updated_at = NOW()`,
        [user.id, environment, apiKeyCiphertext, apiSecretCiphertext],
      );
      return NextResponse.json({ data: { environment, configured: true } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const result = await testBinanceEnvironment(user.id, environment);
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
