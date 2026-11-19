-- SELECT-only; safe before the optional draft schema has been approved/applied.
BEGIN READ ONLY;
-- Quoted aliases match verifyPaperDatabaseIsolation evidence fields.
SELECT expected.table_name AS "table",
       c.oid IS NOT NULL AS installed,
       COALESCE(c.relrowsecurity, FALSE) AS "rowSecurity",
       COALESCE(c.relforcerowsecurity, FALSE) AS "forcedRowSecurity",
       CASE WHEN expected.table_name <> 'paper_account_states' THEN FALSE ELSE EXISTS (
         SELECT 1 FROM pg_constraint owner_check
         WHERE owner_check.conrelid=c.oid AND owner_check.contype='c'
           AND pg_get_constraintdef(owner_check.oid) LIKE '%tenantId%'
           AND pg_get_constraintdef(owner_check.oid) LIKE '%tenant_user_id%'
       ) END AS "tenantConstraint",
       ARRAY(SELECT access.role FROM (VALUES
         ('PUBLIC', EXISTS (SELECT 1 FROM information_schema.table_privileges privileges
           WHERE privileges.table_schema='smartexit_private' AND privileges.table_name=expected.table_name AND privileges.grantee='PUBLIC')),
         ('anon', CASE WHEN c.oid IS NULL THEN FALSE ELSE has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') END),
         ('authenticated', CASE WHEN c.oid IS NULL THEN FALSE ELSE has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') END)
       ) access(role,allowed) WHERE access.allowed) AS "browserGrants"
FROM (VALUES ('paper_account_states'), ('research_decisions')) expected(table_name)
LEFT JOIN pg_namespace n ON n.nspname='smartexit_private'
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=expected.table_name;
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies WHERE schemaname='smartexit_private';
COMMIT;
