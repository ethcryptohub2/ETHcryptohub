-- Read-only verification. Every returned violating_rows count must be zero.
SELECT 'provider_environment_mismatch' AS check_name, COUNT(*) AS violating_rows
  FROM (
    SELECT provider, environment FROM public.admin_demo_exchange_credentials
    UNION ALL
    SELECT provider, environment FROM public.admin_demo_exchange_sessions
    UNION ALL
    SELECT provider, environment FROM public.admin_demo_exchange_authorizations
    UNION ALL
    SELECT provider, environment FROM public.admin_demo_exchange_executions
    UNION ALL
    SELECT provider, environment FROM public.admin_demo_exchange_audit_events
  ) AS scoped_rows
 WHERE NOT (
    (provider = 'GATE' AND environment = 'TESTNET')
    OR (provider <> 'GATE' AND environment = 'DEMO')
 )
UNION ALL
SELECT 'enabled_or_non_confirm_execution_state', COUNT(*)
  FROM public.admin_demo_exchange_credentials
 WHERE is_enabled
UNION ALL
SELECT 'active_admin_identity', COUNT(*)
  FROM public.admin_demo_identities
 WHERE is_active
UNION ALL
SELECT 'enabled_or_non_confirm_session', COUNT(*)
  FROM public.admin_demo_exchange_sessions
 WHERE is_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'enabled_or_non_confirm_execution', COUNT(*)
  FROM public.admin_demo_exchange_executions
 WHERE is_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'non_admin_identity_scope', COUNT(*)
  FROM public.admin_demo_identities
 WHERE admin_scope <> 'ADMIN'
UNION ALL
SELECT 'credential_columns_in_audit_events', COUNT(*)
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'admin_demo_exchange_audit_events'
   AND column_name IN (
       'api_key', 'api_key_ciphertext', 'secret_key', 'secret_key_ciphertext',
       'passphrase', 'passphrase_ciphertext', 'credential', 'credential_id'
   )
UNION ALL
SELECT 'audit_scope_pairing_mismatch', COUNT(*)
  FROM public.admin_demo_exchange_audit_events
 WHERE (session_id IS NULL) <> (authorization_id IS NULL)
UNION ALL
SELECT 'unsafe_column_default', COUNT(*)
  FROM (
    VALUES
      ('admin_demo_identities', 'is_active', 'false'),
      ('admin_demo_exchange_credentials', 'is_enabled', 'false'),
      ('admin_demo_exchange_sessions', 'is_enabled', 'false'),
      ('admin_demo_exchange_sessions', 'execution_mode', '''CONFIRM''::text'),
      ('admin_demo_exchange_executions', 'is_enabled', 'false'),
      ('admin_demo_exchange_executions', 'execution_mode', '''CONFIRM''::text')
  ) AS expected_defaults(table_name, column_name, expected_default)
  LEFT JOIN information_schema.columns AS c
    ON c.table_schema = 'public'
   AND c.table_name = expected_defaults.table_name
   AND c.column_name = expected_defaults.column_name
 WHERE c.column_name IS NULL
    OR c.column_default IS DISTINCT FROM expected_defaults.expected_default
UNION ALL
SELECT 'rls_disabled_table', COUNT(*)
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN (
       'admin_demo_identities',
       'admin_demo_exchange_credentials',
       'admin_demo_exchange_sessions',
       'admin_demo_exchange_authorizations',
       'admin_demo_exchange_executions',
       'admin_demo_exchange_audit_events'
   )
   AND (c.relrowsecurity IS NOT TRUE)
UNION ALL
SELECT 'admin_demo_policy_present', COUNT(*)
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN (
       'admin_demo_identities',
       'admin_demo_exchange_credentials',
       'admin_demo_exchange_sessions',
       'admin_demo_exchange_authorizations',
       'admin_demo_exchange_executions',
       'admin_demo_exchange_audit_events'
   )
UNION ALL
SELECT 'browser_table_privilege', COUNT(*)
  FROM (
    SELECT bool_or(acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated')) AS has_browser_grant
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
      LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE n.nspname = 'public'
       AND c.relname IN (
           'admin_demo_identities',
           'admin_demo_exchange_credentials',
           'admin_demo_exchange_sessions',
           'admin_demo_exchange_authorizations',
           'admin_demo_exchange_executions',
           'admin_demo_exchange_audit_events'
       )
     GROUP BY c.oid
  ) AS table_grants
 WHERE has_browser_grant
UNION ALL
SELECT 'rpc_browser_execute_grant', COUNT(*)
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
 WHERE n.nspname = 'public'
   AND p.proname = 'authorize_admin_demo_exchange_action'
   AND acl.privilege_type = 'EXECUTE'
   AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
UNION ALL
SELECT 'rpc_non_service_role_execute_grant', COUNT(*)
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
 WHERE n.nspname = 'public'
   AND p.proname = 'authorize_admin_demo_exchange_action'
   AND acl.privilege_type = 'EXECUTE'
   AND acl.grantee <> p.proowner
   AND (grantee.rolname IS DISTINCT FROM 'service_role')
UNION ALL
SELECT 'rpc_missing_service_role_execute', CASE WHEN has_function_privilege(
    'service_role',
    'public.authorize_admin_demo_exchange_action(integer,text,bigint,bigint,public.admin_demo_provider,text,text)',
    'EXECUTE'
) THEN 0 ELSE 1 END;
