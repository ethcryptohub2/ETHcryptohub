-- Review-only catalog verification. Select the Staging project independently.
BEGIN TRANSACTION READ ONLY;

SELECT version, name
FROM supabase_migrations.schema_migrations
ORDER BY version;

WITH prerequisites(schema_name, relation_name) AS (
  VALUES ('public', 'admin_demo_identities'),
         ('public', 'admin_demo_exchange_credentials'),
         ('public', 'admin_demo_exchange_sessions'),
         ('public', 'admin_demo_exchange_authorizations'),
         ('public', 'admin_demo_exchange_executions'),
         ('public', 'admin_demo_exchange_audit_events'),
         ('smartexit_private', 'public_market_streams')
)
SELECT schema_name, relation_name, c.oid IS NOT NULL AS installed,
       c.relrowsecurity AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_granted,
       has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS authenticated_granted
FROM prerequisites AS expected
LEFT JOIN pg_namespace AS n ON n.nspname = expected.schema_name
LEFT JOIN pg_class AS c ON c.relnamespace = n.oid AND c.relname = expected.relation_name
ORDER BY schema_name, relation_name;

SELECT n.nspname AS schema_name, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer, p.proconfig AS function_settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'authorize_admin_demo_exchange_action';

ROLLBACK;
