-- Read-only verification for migration 202611050001_initial_schema.sql.
SELECT to_regclass('public.users') AS users,
       to_regclass('public.email_verification_codes') AS email_verification_codes,
       to_regclass('public.email_verification_requests') AS email_verification_requests,
       to_regclass('public.admin_login_attempts') AS admin_login_attempts,
       to_regclass('public.binance_api_credentials') AS binance_api_credentials;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('users', 'email_verification_codes', 'admin_login_attempts', 'binance_api_credentials');
