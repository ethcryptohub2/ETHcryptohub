-- Read-only verification for migration 202611100002_binance_demo_environments.sql.
SELECT conrelid::regclass AS table_name, conname, contype
  FROM pg_constraint
 WHERE conrelid IN (
   'public.binance_api_credentials'::regclass,
   'public.user_trading_settings'::regclass,
   'public.trade_executions'::regclass
 )
   AND (conname LIKE '%environment%' OR conname LIKE '%signal%')
 ORDER BY table_name::text, conname;

SELECT environment, COUNT(*) AS credential_rows
  FROM public.binance_api_credentials
 GROUP BY environment
 ORDER BY environment;

SELECT environment, COUNT(*) AS execution_rows
  FROM public.trade_executions
 GROUP BY environment
 ORDER BY environment;

SELECT COUNT(*) AS settings_rows,
       COUNT(*) FILTER (WHERE live_kill_switch_enabled) AS live_kill_switch_rows
  FROM public.user_trading_settings;

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'binance_api_credentials';
