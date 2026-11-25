-- Read-only verification for migration 202611060001_market_research.sql.
SELECT to_regclass('public.market_research_credentials') AS market_research_credentials;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'market_research_credentials';
