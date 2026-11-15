-- Read-only verification for migration 202611110003_binance_credential_environment_confirmation.sql.
SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('binance_api_credentials', 'exchange_api_credentials')
   AND column_name = 'environment_confirmed'
 ORDER BY table_name;

SELECT 'binance_api_credentials' AS table_name,
       COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE environment_confirmed) AS confirmed_rows,
       COUNT(*) FILTER (WHERE NOT environment_confirmed) AS requires_reentry_rows
  FROM public.binance_api_credentials
UNION ALL
SELECT 'exchange_api_credentials',
       COUNT(*),
       COUNT(*) FILTER (WHERE environment_confirmed),
       COUNT(*) FILTER (WHERE NOT environment_confirmed)
  FROM public.exchange_api_credentials;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('binance_api_credentials', 'exchange_api_credentials')
 ORDER BY c.relname;
