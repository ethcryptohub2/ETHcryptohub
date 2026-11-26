import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireUser } from '../../../lib/auth';
import { listExchangeProviders } from '../../../lib/exchanges/providers';
import { ExchangeFoundationBlockedError } from '../../../lib/exchanges/schema';
import { isExchangeEnvironment, isExchangeId } from '../../../lib/exchanges/types';
import { validCsrf } from '../../../lib/http';
import { query } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toggleExchangeSchema = z.object({
  exchange: z.enum(['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE']),
  environment: z.enum(['DEMO', 'TESTNET']),
  enabled: z.boolean(),
}).strict();

export async function GET() {
  try {
    const user = await requireUser();
    const [providers, exchangeCreds, binanceCreds, userSwitches] = await Promise.all([
      listExchangeProviders(),
      query<{ exchange: string; environment: string; environment_confirmed: boolean; last_verified_at: string | null }>(
        `SELECT exchange, environment, environment_confirmed, last_verified_at
           FROM public.exchange_api_credentials
          WHERE user_id = $1`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{ environment: string; environment_confirmed: boolean; updated_at: string }>(
        `SELECT environment, environment_confirmed, updated_at
           FROM public.binance_api_credentials
          WHERE user_id = $1`,
        [user.id],
      ).catch(() => ({ rows: [] })),
      query<{ exchange: string; environment: string; auto_trade_enabled: boolean; execution_mode: string; emergency_stop_enabled: boolean }>(
        `SELECT exchange, environment, auto_trade_enabled, execution_mode, emergency_stop_enabled
           FROM public.user_exchange_trading_settings
          WHERE user_id = $1 AND environment IN ('DEMO', 'TESTNET')`,
        [user.id],
      ).catch(() => ({ rows: [] })),
    ]);

    const configuredMap = new Map<string, { configured: boolean; lastVerifiedAt: string | null }>();
    for (const row of exchangeCreds.rows) {
      if (row.environment_confirmed) {
        configuredMap.set(`${row.exchange}:${row.environment}`, {
          configured: true,
          lastVerifiedAt: row.last_verified_at,
        });
      }
    }
    for (const row of binanceCreds.rows) {
      if (row.environment_confirmed && !configuredMap.has(`BINANCE:${row.environment}`)) {
        configuredMap.set(`BINANCE:${row.environment}`, {
          configured: true,
          lastVerifiedAt: null,
        });
      }
    }

    const switchMap = new Map<string, { autoTradeEnabled: boolean; executionMode: string; emergencyStopEnabled: boolean }>();
    for (const row of userSwitches.rows) {
      switchMap.set(`${row.exchange}:${row.environment}`, {
        autoTradeEnabled: Boolean(row.auto_trade_enabled),
        executionMode: row.execution_mode,
        emergencyStopEnabled: Boolean(row.emergency_stop_enabled),
      });
    }

    const data = providers.map((provider) => ({
      exchange: provider.exchange,
      name: provider.name,
      environments: provider.environments
        .map((environment) => {
          const key = `${provider.exchange}:${environment.environment}`;
          const userStatus = configuredMap.get(key);
          const userSwitch = switchMap.get(key);
          const isConfigured = Boolean(userStatus?.configured);
          return {
            environment: environment.environment,
            enabled: environment.enabled,
            supported: environment.supported,
            available: environment.enabled && environment.supported && provider.customer_enabled,
            customerTradingReady: environment.customerTradingReady,
            configuredAccounts: isConfigured ? 1 : 0,
            configured: isConfigured,
            lastVerifiedAt: userStatus?.lastVerifiedAt ?? null,
            userAutoTradeEnabled: userSwitch?.autoTradeEnabled ?? false,
            userExecutionMode: userSwitch?.executionMode ?? 'CONFIRM',
            userEmergencyStopEnabled: userSwitch?.emergencyStopEnabled ?? false,
          };
        }),
    }));
    return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      error instanceof ExchangeFoundationBlockedError
        ? { code: 'SCHEMA_BLOCKED', error: error.message }
        : { error: error instanceof AuthError ? error.message : 'Exchange connections are unavailable.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const user = await requireUser();
    const body: unknown = await request.json().catch(() => null);
    const parsed = toggleExchangeSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: 'Invalid exchange execution switch request.' }, { status: 422 });
    }
    const { exchange, environment, enabled } = parsed.data;
    if (!isExchangeId(exchange) || !isExchangeEnvironment(exchange, environment)) {
      return Response.json({ error: `${exchange} does not support ${environment}.` }, { status: 422 });
    }
    const executionMode = enabled ? 'AUTOMATIC' : 'CONFIRM';
    await query(
      `INSERT INTO public.user_exchange_trading_settings (
         user_id, exchange, environment, execution_mode, auto_trade_enabled, emergency_stop_enabled, updated_at
       ) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())
       ON CONFLICT (user_id, exchange, environment) DO UPDATE SET
         execution_mode = EXCLUDED.execution_mode,
         auto_trade_enabled = EXCLUDED.auto_trade_enabled,
         updated_at = NOW()`,
      [user.id, exchange, environment, executionMode, enabled],
    );
    return Response.json(
      { data: { exchange, environment, autoTradeEnabled: enabled, executionMode } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json(
      { error: error instanceof Error ? error.message : 'Could not update exchange switch.' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
