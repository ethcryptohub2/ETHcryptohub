-- Read-only verification for the isolated Admin Binance Demo testing schema.
-- Run only against the independently confirmed Staging database after approval.
SELECT t.table_name, c.relrowsecurity AS row_security
  FROM information_schema.tables t
  JOIN pg_catalog.pg_class c ON c.relname = t.table_name
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
 WHERE t.table_schema = 'public'
   AND t.table_name IN (
       'admin_binance_demo_test_accounts',
       'admin_demo_test_account_events',
       'admin_demo_test_sessions',
       'admin_demo_test_authorizations',
       'admin_demo_test_executions',
       'admin_demo_test_events'
   )
 ORDER BY t.table_name;

SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN (
       'admin_binance_demo_test_accounts',
       'admin_demo_test_account_events',
       'admin_demo_test_sessions',
       'admin_demo_test_authorizations',
       'admin_demo_test_executions',
       'admin_demo_test_events'
   )
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
 ORDER BY table_name, grantee, privilege_type;

SELECT conrelid::regclass AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
  FROM pg_catalog.pg_constraint
 WHERE conrelid IN (
       'public.admin_binance_demo_test_accounts'::regclass,
       'public.admin_demo_test_account_events'::regclass,
       'public.admin_demo_test_sessions'::regclass,
       'public.admin_demo_test_authorizations'::regclass,
       'public.admin_demo_test_executions'::regclass,
       'public.admin_demo_test_events'::regclass
   )
 ORDER BY conrelid::regclass::TEXT, conname;

SELECT schemaname, tablename, indexname, indexdef
  FROM pg_catalog.pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN (
       'admin_binance_demo_test_accounts',
       'admin_demo_test_account_events',
       'admin_demo_test_sessions',
       'admin_demo_test_authorizations',
       'admin_demo_test_executions',
       'admin_demo_test_events'
   )
 ORDER BY tablename, indexname;

SELECT routine_name, security_type, routine_definition
  FROM information_schema.routines
 WHERE specific_schema = 'public'
   AND routine_name = 'authorize_admin_demo_test_action';

SELECT grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name = 'authorize_admin_demo_test_action'
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
 ORDER BY grantee, privilege_type;

-- Counts only; deliberately excludes ciphertext, API key suffixes, and test evidence.
SELECT
    (SELECT COUNT(*) FROM public.admin_binance_demo_test_accounts) AS admin_demo_account_count,
    (SELECT COUNT(*) FROM public.admin_demo_test_account_events) AS account_audit_event_count,
    (SELECT COUNT(*) FROM public.admin_demo_test_sessions) AS test_session_count,
    (SELECT COUNT(*) FROM public.admin_demo_test_authorizations) AS authorization_count,
    (SELECT COUNT(*) FROM public.admin_demo_test_executions) AS test_execution_count,
    (SELECT COUNT(*) FROM public.admin_demo_test_events) AS test_event_count;
