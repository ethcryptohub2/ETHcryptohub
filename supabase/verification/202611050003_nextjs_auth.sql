-- Read-only verification for migration 202611050003_nextjs_auth.sql.
SELECT to_regclass('public.auth_sessions') AS auth_sessions,
       to_regclass('public.auth_rate_limits') AS auth_rate_limits;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('auth_sessions', 'auth_rate_limits');
