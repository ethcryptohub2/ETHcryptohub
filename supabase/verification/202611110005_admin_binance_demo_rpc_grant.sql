-- Read-only verification for the Admin Demo server-only authorization RPC grant.
SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name = 'authorize_admin_demo_test_action'
   AND grantee IN ('service_role', 'PUBLIC', 'anon', 'authenticated')
 ORDER BY grantee;
