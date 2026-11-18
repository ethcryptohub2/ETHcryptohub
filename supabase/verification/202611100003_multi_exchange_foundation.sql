-- Read-only verification for migration 202611100003_multi_exchange_foundation.sql.
SELECT to_regclass('public.exchange_api_credentials') AS exchange_api_credentials,
       to_regclass('public.user_exchange_preferences') AS user_exchange_preferences,
       to_regclass('public.user_exchange_trading_settings') AS user_exchange_trading_settings,
       to_regclass('public.exchange_provider_settings') AS exchange_provider_settings,
       to_regclass('public.exchange_execution_events') AS exchange_execution_events,
       to_regclass('public.admin_exchange_audit_log') AS admin_exchange_audit_log;

SELECT exchange, environment, COUNT(*) AS rows
  FROM public.exchange_api_credentials
 GROUP BY exchange, environment
 ORDER BY exchange, environment;

SELECT exchange, environment, COUNT(*) AS rows
  FROM public.trade_executions
 GROUP BY exchange, environment
 ORDER BY exchange, environment;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN (
     'exchange_api_credentials', 'user_exchange_preferences',
     'user_exchange_trading_settings', 'exchange_provider_settings',
     'exchange_execution_events', 'admin_exchange_audit_log'
   )
 ORDER BY c.relname;

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
     'exchange_api_credentials', 'user_exchange_preferences',
     'user_exchange_trading_settings', 'exchange_provider_settings',
     'exchange_execution_events', 'admin_exchange_audit_log'
   )
 ORDER BY tablename, policyname;

-- New provider configuration must remain disabled and confirmation-gated.
SELECT 'provider_access_enabled' AS check_name, COUNT(*) AS violating_rows
  FROM public.exchange_provider_settings
 WHERE customer_enabled OR demo_enabled OR testnet_enabled OR live_enabled
UNION ALL
SELECT 'automatic_exchange_execution', COUNT(*)
  FROM public.user_exchange_trading_settings
 WHERE auto_trade_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'non_demo_initial_exchange_preference', COUNT(*)
  FROM public.user_exchange_preferences
 WHERE active_environment <> 'DEMO';
