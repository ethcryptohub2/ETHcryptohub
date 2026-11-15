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
import { assertExchangeEnabledForCustomer } from '../../../../lib/exchanges/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const exchangeSchema = z.literal('BYBIT');
const environmentSchema = z.literal('DEMO');
const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    exchange: exchangeSchema,
    environment: environmentSchema,
    apiKey: z.string().min(8).max(256),
    apiSecret: z.string().min(8).max(512),
  }).strict(),
  z.object({ action: z.literal('remove'), exchange: exchangeSchema, environment: environmentSchema }).strict(),
  z.object({ action: z.literal('test'), exchange: exchangeSchema, environment: environmentSchema }).strict(),
]);

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const exchange = request.nextUrl.searchParams.get('exchange');
    const environment = request.nextUrl.searchParams.get('environment');
    if (exchange !== 'BYBIT' || environment !== 'DEMO') {
      return Response.json({ error: 'Unsupported exchange credential environment.' }, { status: 422 });
    }
    return Response.json({
      data: await getExchangeCredentialStatus(user.id, 'BYBIT', 'DEMO'),
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
    if (!parsed.success) return Response.json({ error: 'Invalid Bybit Demo credential request.' }, { status: 422 });
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
      });
      return Response.json({ data: await getExchangeCredentialStatus(user.id, input.exchange, input.environment) }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const adapter = createBybitDemoAdapter(
      await loadExchangeCredentials(user.id, input.exchange, input.environment),
    );
    await adapter.testConnection();
    await markExchangeCredentialsVerified(user.id, input.exchange, input.environment);
    return Response.json({
      data: await getExchangeCredentialStatus(user.id, input.exchange, input.environment),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof BybitDemoError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Bybit Demo request failed.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
