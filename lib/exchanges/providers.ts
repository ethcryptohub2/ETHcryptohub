import { query } from '../db';
import { EXCHANGE_REGISTRY } from './registry';
import { assertExchangeFoundationReady } from './schema';
import type { ExchangeEnvironment, ExchangeId } from './types';
import { isExchangeEnvironment, isExchangeId } from './types';

type ProviderRow = {
  exchange: ExchangeId;
  customer_enabled: boolean;
  demo_enabled: boolean;
  testnet_enabled: boolean;
  live_enabled: boolean;
  adapter_version: string;
  demo_verified_at: string | null;
  testnet_verified_at: string | null;
  live_approved_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
};

function isEnvironmentEnabled(row: ProviderRow, environment: ExchangeEnvironment) {
  if (environment === 'DEMO') return row.demo_enabled;
  if (environment === 'TESTNET') return row.testnet_enabled;
  return row.live_enabled;
}

export async function listExchangeProviders() {
  await assertExchangeFoundationReady();
  const [settings, counts, checks] = await Promise.all([
    query<ProviderRow>(
      `SELECT exchange, customer_enabled, demo_enabled, testnet_enabled, live_enabled,
              adapter_version, demo_verified_at, testnet_verified_at, live_approved_at,
              last_verified_at, last_error
         FROM public.exchange_provider_settings
        ORDER BY CASE exchange
          WHEN 'BINANCE' THEN 1 WHEN 'BYBIT' THEN 2 WHEN 'OKX' THEN 3
          WHEN 'BITGET' THEN 4 ELSE 5 END`,
    ),
    query<{ exchange: ExchangeId; environment: ExchangeEnvironment; configured: string }>(
      `SELECT exchange, environment, COUNT(*)::TEXT AS configured
         FROM public.exchange_api_credentials
        GROUP BY exchange, environment`,
    ),
    query<{
      exchange: ExchangeId;
      environment: ExchangeEnvironment;
      status: string;
      created_at: string;
    }>(
      `SELECT DISTINCT ON (exchange, environment) exchange, environment, status, created_at
         FROM public.exchange_execution_events
        WHERE event_type = 'TESTCONNECTION'
        ORDER BY exchange, environment, created_at DESC`,
    ),
  ]);
  const credentialCounts = new Map(
    counts.rows.map((row) => [`${row.exchange}:${row.environment}`, Number(row.configured)]),
  );
  const lastChecks = new Map(
    checks.rows.map((row) => [`${row.exchange}:${row.environment}`, { status: row.status, checkedAt: row.created_at }]),
  );
  return settings.rows.map((row) => {
    const definition = EXCHANGE_REGISTRY[row.exchange];
    return {
      exchange: row.exchange,
      customer_enabled: row.customer_enabled,
      adapter_version: row.adapter_version,
      demo_verified_at: row.demo_verified_at,
      testnet_verified_at: row.testnet_verified_at,
      live_approved_at: row.live_approved_at,
      last_verified_at: row.last_verified_at,
      hasIntegrationError: Boolean(row.last_error),
      name: definition.name,
      environments: definition.environments.map((environment) => ({
        environment,
        enabled: isEnvironmentEnabled(row, environment),
        supported: definition.capabilities.connectionTest,
        customerTradingReady: definition.customerTradingReady,
        configuredAccounts: credentialCounts.get(`${row.exchange}:${environment}`) ?? 0,
        lastConnectionTest: lastChecks.get(`${row.exchange}:${environment}`) ?? null,
      })),
      capabilities: definition.capabilities,
    };
  });
}

export async function assertExchangeEnabledForCustomer(
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
  operation: 'connect' | 'trade',
) {
  await assertExchangeFoundationReady();
  if (!isExchangeEnvironment(exchange, environment)) {
    throw new Error(`${exchange} does not support ${environment}.`);
  }
  const definition = EXCHANGE_REGISTRY[exchange];
  if (operation === 'trade' && !definition.customerTradingReady) {
    throw new Error(`${definition.name} trading is disabled until its Demo/Testnet integration and protection lifecycle are verified.`);
  }
  const result = await query<ProviderRow>(
    `SELECT exchange, customer_enabled, demo_enabled, testnet_enabled, live_enabled,
            adapter_version, demo_verified_at, testnet_verified_at, live_approved_at,
            last_verified_at, last_error
       FROM public.exchange_provider_settings WHERE exchange = $1`,
    [exchange],
  );
  const provider = result.rows[0];
  if (!provider || !provider.customer_enabled || !isEnvironmentEnabled(provider, environment)) {
    throw new Error(`${definition.name} ${environment} is disabled by the administrator.`);
  }
  if (operation === 'trade') {
    if (environment === 'LIVE' && !provider.live_approved_at) {
      throw new Error(`${definition.name} Live trading has not been separately approved.`);
    }
    if (environment === 'DEMO' && !provider.demo_verified_at) {
      throw new Error(`${definition.name} Demo trading has not been verified by the administrator.`);
    }
    if (environment === 'TESTNET' && !provider.testnet_verified_at) {
      throw new Error(`${definition.name} Testnet trading has not been verified by the administrator.`);
    }
  }
}

export async function updateExchangeProviderSetting(
  adminUserId: number,
  exchange: ExchangeId,
  input: { customerEnabled?: boolean; environment: ExchangeEnvironment; enabled: boolean },
) {
  await assertExchangeFoundationReady();
  if (!isExchangeId(exchange) || !isExchangeEnvironment(exchange, input.environment)) {
    throw new Error('Unsupported exchange environment.');
  }
  if (input.customerEnabled === true && !EXCHANGE_REGISTRY[exchange].customerTradingReady) {
    throw new Error('Customer access cannot be enabled before all exchange capabilities and Demo/Testnet protection tests are verified.');
  }
  if (input.environment === 'LIVE' && input.enabled) {
    throw new Error('Live access requires a separate reviewed approval flow and cannot be enabled from this provider toggle.');
  }
  const environmentColumn = input.environment === 'DEMO'
    ? 'demo_enabled'
    : input.environment === 'TESTNET'
      ? 'testnet_enabled'
      : 'live_enabled';
  const verifiedColumn = input.environment === 'DEMO'
    ? 'demo_verified_at'
    : input.environment === 'TESTNET'
      ? 'testnet_verified_at'
      : 'live_approved_at';
  const result = await query(
    `WITH previous AS (
       SELECT exchange, ${environmentColumn} AS enabled
         FROM public.exchange_provider_settings
        WHERE exchange = $1
        FOR UPDATE
     ),
     updated AS (
       UPDATE public.exchange_provider_settings AS settings
          SET ${environmentColumn} = $2,
              customer_enabled = COALESCE($3, settings.customer_enabled),
              updated_by = $4, updated_at = NOW()
         FROM previous
        WHERE settings.exchange = previous.exchange
          AND ($2 = FALSE OR $5 = 'LIVE' OR ${verifiedColumn} IS NOT NULL)
       RETURNING settings.exchange, settings.${environmentColumn} AS enabled
     )
     INSERT INTO public.admin_exchange_audit_log (
       admin_user_id, exchange, action, previous_value, new_value
     )
     SELECT $4, updated.exchange, 'ENVIRONMENT_TOGGLE',
            jsonb_build_object('environment', $5, 'enabled', previous.enabled),
            jsonb_build_object('environment', $5, 'enabled', updated.enabled)
       FROM previous JOIN updated USING (exchange)
     RETURNING id`,
    [exchange, input.enabled, input.customerEnabled ?? null, adminUserId, input.environment],
  );
  if (!result.rowCount) {
    throw new Error(input.enabled
      ? `${exchange} ${input.environment} must pass admin verification before it can be enabled.`
      : `Provider settings for ${exchange} were not found.`);
  }
}

export async function setCustomerExchangeEnabled(
  adminUserId: number,
  exchange: ExchangeId,
  enabled: boolean,
) {
  await assertExchangeFoundationReady();
  if (!isExchangeId(exchange)) throw new Error('Unsupported exchange.');
  if (enabled && !EXCHANGE_REGISTRY[exchange].customerTradingReady) {
    throw new Error(`${exchange} cannot be enabled for customers until its trading adapter and Demo/Testnet protection flow are verified.`);
  }
  const result = await query(
    `WITH previous AS (
       SELECT exchange, customer_enabled
         FROM public.exchange_provider_settings
        WHERE exchange = $1
        FOR UPDATE
     ),
     updated AS (
       UPDATE public.exchange_provider_settings AS settings
          SET customer_enabled = $2, updated_by = $3, updated_at = NOW()
         FROM previous
        WHERE settings.exchange = previous.exchange
       RETURNING settings.exchange, settings.customer_enabled
     )
     INSERT INTO public.admin_exchange_audit_log (
       admin_user_id, exchange, action, previous_value, new_value
     )
     SELECT $3, updated.exchange, 'CUSTOMER_ACCESS_TOGGLE',
            jsonb_build_object('customerEnabled', previous.customer_enabled),
            jsonb_build_object('customerEnabled', updated.customer_enabled)
       FROM previous JOIN updated USING (exchange)
     RETURNING id`,
    [exchange, enabled, adminUserId],
  );
  if (!result.rowCount) throw new Error(`Provider settings for ${exchange} were not found.`);
}
