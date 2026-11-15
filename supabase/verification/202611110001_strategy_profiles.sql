-- Read-only verification for migration 202611110001_strategy_profiles.sql.
SELECT to_regclass('public.user_strategy_settings') AS user_strategy_settings;

SELECT strategy, enabled, environment, COUNT(*) AS profile_count,
       COUNT(*) FILTER (
         WHERE max_open_positions IS NULL OR max_daily_loss_percent IS NULL
       ) AS profiles_missing_required_limits
  FROM public.user_strategy_settings
 GROUP BY strategy, enabled, environment
 ORDER BY strategy, enabled, environment;

SELECT strategy, COUNT(*) AS execution_count
  FROM public.trade_executions
 GROUP BY strategy
 ORDER BY strategy;

SELECT execution_status, COUNT(*) AS execution_count
  FROM public.trade_executions
 GROUP BY execution_status
 ORDER BY execution_status;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'user_strategy_settings';

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'user_strategy_settings';
