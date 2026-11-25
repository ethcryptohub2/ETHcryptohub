import { AuthError, requireUser } from '../../../lib/auth';
import { listExchangeProviders } from '../../../lib/exchanges/providers';
import { ExchangeFoundationBlockedError } from '../../../lib/exchanges/schema';
import { query } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireUser();
    const [providers, exchangeCreds, binanceCreds] = await Promise.all([
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
          lastVerifiedAt: row.updated_at,
        });
      }
    }

    const data = providers.map((provider) => ({
      exchange: provider.exchange,
      name: provider.name,
      environments: provider.environments
        .map((environment) => {
          const userStatus = configuredMap.get(`${provider.exchange}:${environment.environment}`);
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
