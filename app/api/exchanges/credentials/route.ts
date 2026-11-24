import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import {
  getExchangeCredentialStatus,
  loadExchangeCredentials,
  markExchangeCredentialsVerified,
  removeExchangeCredentials,
  saveExchangeCredentials,
} from '../../../../lib/exchanges/credentials';
import { BybitDemoError, createBybitDemoAdapter } from '../../../../lib/exchanges/bybit-demo';
import { OkxDemoError, createOkxDemoAdapter } from '../../../../lib/exchanges/okx-demo';
import { BitgetDemoError, createBitgetDemoAdapter } from '../../../../lib/exchanges/bitget-demo';
import { GateTestnetError, createGateTestnetAdapter } from '../../../../lib/exchanges/gate-testnet';
import { assertExchangeEnabledForCustomer } from '../../../../lib/exchanges/providers';
import type { ExchangeId, ExchangeEnvironment } from '../../../../lib/exchanges/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const exchangeSchema = z.enum(['BYBIT', 'OKX', 'BITGET', 'GATE']);
const environmentSchema = z.enum(['DEMO', 'TESTNET']);
const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    exchange: exchangeSchema,
    environment: environmentSchema,
    apiKey: z.string().min(8).max(256),
    apiSecret: z.string().min(8).max(512),
    passphrase: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({ action: z.literal('remove'), exchange: exchangeSchema, environment: environmentSchema }).strict(),
  z.object({ action: z.literal('test'), exchange: exchangeSchema, environment: environmentSchema }).strict(),
]);

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const exchange = request.nextUrl.searchParams.get('exchange') as ExchangeId | null;
    const environment = request.nextUrl.searchParams.get('environment') as ExchangeEnvironment | null;
    if (
      !exchange ||
      !environment ||
      !['BYBIT', 'OKX', 'BITGET', 'GATE'].includes(exchange) ||
      !['DEMO', 'TESTNET'].includes(environment)
    ) {
      return Response.json({ error: 'Unsupported exchange credential environment.' }, { status: 422 });
    }
    return Response.json({
      data: await getExchangeCredentialStatus(user.id, exchange, environment),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Exchange credentials are unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid exchange credential request.' }, { status: 422 });
    const input = parsed.data;

    if (input.action === 'remove') {
      await removeExchangeCredentials(user.id, input.exchange, input.environment);
      return Response.json({ data: await getExchangeCredentialStatus(user.id, input.exchange, input.environment) }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    await assertExchangeEnabledForCustomer(input.exchange, input.environment, 'connect');
    if (input.action === 'save') {
      await saveExchangeCredentials(user.id, input.exchange, input.environment, {
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
        passphrase: 'passphrase' in input ? input.passphrase : undefined,
      });
      return Response.json({ data: await getExchangeCredentialStatus(user.id, input.exchange, input.environment) }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const credentials = await loadExchangeCredentials(user.id, input.exchange, input.environment);
    if (input.exchange === 'BYBIT') {
      const adapter = createBybitDemoAdapter(credentials);
      await adapter.testConnection();
    } else if (input.exchange === 'OKX') {
      const adapter = createOkxDemoAdapter(credentials);
      await adapter.testConnection();
    } else if (input.exchange === 'GATE') {
      const adapter = createGateTestnetAdapter(credentials);
      await adapter.testConnection();
    } else if (input.exchange === 'BITGET') {
      createBitgetDemoAdapter(input.environment);
    }
    await markExchangeCredentialsVerified(user.id, input.exchange, input.environment);
    return Response.json({
      data: await getExchangeCredentialStatus(user.id, input.exchange, input.environment),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status =
      error instanceof AuthError ||
      error instanceof BybitDemoError ||
      error instanceof OkxDemoError ||
      error instanceof GateTestnetError ||
      error instanceof BitgetDemoError
        ? (error as { status?: number }).status ?? 503
        : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : `${(request as unknown as { exchange?: string }).exchange ?? 'Exchange'} request failed.` },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
