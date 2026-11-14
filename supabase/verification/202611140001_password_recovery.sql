SELECT
    c.relname AS table_name,
    c.relrowsecurity AS row_level_security_enabled,
    c.relforcerowsecurity AS row_level_security_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'auth_password_reset_codes';

SELECT
    grantee,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'auth_password_reset_codes'
  AND grantee IN ('anon', 'authenticated')
ORDER BY grantee, privilege_type;
