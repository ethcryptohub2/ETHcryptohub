import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import {
  listExchangeProviders,
  setCustomerExchangeEnabled,
  updateExchangeProviderSetting,
} from '../../../../lib/exchanges/providers';
import { EXCHANGE_IDS } from '../../../../lib/exchanges/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('environment'),
    exchange: z.enum(EXCHANGE_IDS),
    environment: z.enum(['DEMO', 'TESTNET', 'LIVE']),
    enabled: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('customer'),
    exchange: z.enum(EXCHANGE_IDS),
    enabled: z.boolean(),
  }).strict(),
]);

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ data: await listExchangeProviders() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Exchange controls are unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) {
    return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  }
  try {
    const admin = await requireAdmin();
    const body: unknown = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid exchange provider setting.' }, { status: 422 });
    if (parsed.data.type === 'customer') {
      await setCustomerExchangeEnabled(admin.id, parsed.data.exchange, parsed.data.enabled);
    } else {
      await updateExchangeProviderSetting(admin.id, parsed.data.exchange, {
        environment: parsed.data.environment,
        enabled: parsed.data.enabled,
      });
    }
    return Response.json({ data: await listExchangeProviders() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Exchange provider setting could not be updated.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
