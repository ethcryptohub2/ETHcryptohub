import { query } from '../db';

export class ExchangeFoundationBlockedError extends Error {
  constructor() {
    super('Exchange connections require the reviewed multi-exchange and credential migration sequence.');
  }
}

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
    throw new ExchangeFoundationBlockedError();
  }
}
