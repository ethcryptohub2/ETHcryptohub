-- Read-only verification for migration 202611100001_live_futures_trading.sql.
SELECT to_regclass('public.user_trading_settings') AS user_trading_settings,
       to_regclass('public.trade_executions') AS trade_executions;

SELECT conrelid::regclass AS table_name, conname, contype
  FROM pg_constraint
 WHERE conrelid IN (
   'public.user_trading_settings'::regclass,
   'public.trade_executions'::regclass
 )
 ORDER BY conrelid::regclass::text, conname;

SELECT tablename, policyname, cmd, roles
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('user_trading_settings', 'trade_executions')
 ORDER BY tablename, policyname;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('user_trading_settings', 'trade_executions');

SELECT 'user_trading_settings' AS table_name, COUNT(*) AS row_count
  FROM public.user_trading_settings
UNION ALL
SELECT 'trade_executions', COUNT(*) FROM public.trade_executions;
