import { query } from '../db';

export async function assertExchangeFoundationReady() {
  const result = await query<{ ready: boolean }>(
    `SELECT
       to_regclass('public.exchange_api_credentials') IS NOT NULL
       AND to_regclass('public.user_exchange_preferences') IS NOT NULL
       AND to_regclass('public.user_exchange_trading_settings') IS NOT NULL
       AND to_regclass('public.exchange_provider_settings') IS NOT NULL
       AND to_regclass('public.exchange_execution_events') IS NOT NULL
       AND to_regclass('public.admin_exchange_audit_log') IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'binance_api_credentials'
            AND column_name = 'environment_confirmed'
       )
       AND EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'exchange_api_credentials'
            AND column_name = 'environment_confirmed'
       )
       AND EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'trade_executions'
            AND column_name = 'exchange'
       ) AS ready`,
  );
  if (!result.rows[0]?.ready) {
    throw new Error('Multi-exchange credential schema is not installed. Apply migrations 202611100003_multi_exchange_foundation.sql and 202611110003_binance_credential_environment_confirmation.sql with this application release.');
  }
}
