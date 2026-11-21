import { AuthError, requireUser } from '../../../lib/auth';
import { listExchangeProviders } from '../../../lib/exchanges/providers';
import { ExchangeFoundationBlockedError } from '../../../lib/exchanges/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUser();
    const providers = await listExchangeProviders();
    const data = providers.map((provider) => ({
      exchange: provider.exchange,
      name: provider.name,
      environments: provider.environments
        .map((environment) => ({
          environment: environment.environment,
          enabled: environment.enabled,
          supported: environment.supported,
          available: environment.enabled && environment.supported && provider.customer_enabled,
          customerTradingReady: environment.customerTradingReady,
        })),
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
