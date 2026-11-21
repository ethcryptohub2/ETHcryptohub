-- Read-only Staging release checks.
-- Run only against the independently confirmed Staging project after operator approval.
-- Each section is SELECT-only and wrapped in a read-only transaction.

-- PRE-MIGRATION BASELINE: expected remote boundary is 202611100002.
BEGIN READ ONLY;

-- MCP-applied migrations may use application-time versions and keep the
-- filename prefix in name. An empty version-only filter is not a clean ledger.
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE COALESCE(substring(name FROM '^([0-9]{12})'), version::TEXT) IN (
       '202611070003', '202611100001', '202611100002', '202611100003', '202611100004',
       '202611110001', '202611110002', '202611110003', '202611110004',
       '202611110005', '202611110006', '202611110007', '202611140001'
 )
 ORDER BY version;

-- Must return no rows at boundary 202611100002. Existing objects indicate schema
-- drift or a partially applied migration and require manual review before proceeding.
SELECT expected.table_name
  FROM (
    VALUES
      ('exchange_api_credentials'),
      ('user_exchange_preferences'),
      ('user_exchange_trading_settings'),
      ('exchange_provider_settings'),
      ('exchange_execution_events'),
      ('admin_exchange_audit_log'),
      ('user_strategy_settings'),
      ('admin_binance_demo_test_accounts'),
      ('admin_demo_test_sessions'),
      ('admin_demo_test_authorizations'),
      ('admin_demo_test_executions'),
      ('admin_demo_identities'),
      ('admin_demo_exchange_credentials'),
      ('admin_demo_exchange_sessions'),
      ('admin_demo_exchange_authorizations'),
      ('admin_demo_exchange_executions'),
      ('admin_demo_exchange_audit_events')
  ) AS expected(table_name)
 WHERE to_regclass('public.' || quote_ident(expected.table_name)) IS NOT NULL
 ORDER BY expected.table_name;

SELECT 'users' AS table_name, COUNT(*) AS row_count FROM public.users
UNION ALL
SELECT 'binance_api_credentials', COUNT(*) FROM public.binance_api_credentials
UNION ALL
SELECT 'user_trading_settings', COUNT(*) FROM public.user_trading_settings
UNION ALL
SELECT 'trade_executions', COUNT(*) FROM public.trade_executions;

SELECT environment, COUNT(*) AS credential_rows
  FROM public.binance_api_credentials
 GROUP BY environment
 ORDER BY environment;

SELECT environment, execution_status, COUNT(*) AS execution_rows
  FROM public.trade_executions
 GROUP BY environment, execution_status
 ORDER BY environment, execution_status;

-- Both incompatible_rows counts must be zero before 100003 copies credentials.
SELECT 'binance_credential_environment' AS check_name, COUNT(*) AS incompatible_rows
  FROM public.binance_api_credentials
 WHERE environment NOT IN ('DEMO', 'LIVE')
UNION ALL
SELECT 'trade_execution_environment', COUNT(*)
  FROM public.trade_executions
 WHERE environment NOT IN ('DEMO', 'LIVE');

-- Must return no rows before 202611100003 adds the exchange/environment key.
SELECT user_id, signal_id, environment, COUNT(*) AS duplicate_rows
  FROM public.trade_executions
 GROUP BY user_id, signal_id, environment
HAVING COUNT(*) > 1;

-- Must return no rows before 202611110002 installs the stricter status constraint.
SELECT execution_status, COUNT(*) AS incompatible_rows
  FROM public.trade_executions
 WHERE execution_status NOT IN (
       'AWAITING_CONFIRMATION', 'EXECUTING', 'ENTRY_FILLED', 'PROTECTED',
       'FAILED', 'PROTECTION_FAILED', 'REJECTED', 'CANCELLED', 'CLOSED'
 )
 GROUP BY execution_status;

-- Captures the expected matched-row count for 202611110001's strategy backfill.
SELECT COUNT(*) AS expected_strategy_backfill_rows
  FROM public.trade_executions AS execution
  JOIN public.market_signals AS signal ON signal.id = execution.signal_id;

-- Expected affected-row counts for the all-row safety UPDATEs. These formulas
-- assume the boundary check above returns no pending-schema objects.
SELECT '202611100004.exchange_provider_settings' AS migration_table,
       5::BIGINT AS expected_updated_rows
UNION ALL
SELECT '202611100004.user_exchange_trading_settings',
       2 * COUNT(*)::BIGINT
  FROM public.user_trading_settings
UNION ALL
SELECT '202611110006.exchange_provider_settings',
       5::BIGINT
UNION ALL
SELECT '202611110006.user_exchange_trading_settings',
       2 * COUNT(*)::BIGINT
  FROM public.user_trading_settings
UNION ALL
SELECT '202611110006.user_strategy_settings',
       2 * COUNT(*)::BIGINT
  FROM public.users
UNION ALL
SELECT '202611110006.user_trading_settings',
       COUNT(*)::BIGINT
  FROM public.user_trading_settings
ORDER BY migration_table;

-- Values are aggregates only; no credential material is selected.
SELECT
    COUNT(*) AS settings_rows,
    COUNT(*) FILTER (WHERE demo_auto_trade_enabled) AS demo_auto_trade_rows,
    COUNT(*) FILTER (WHERE live_auto_trade_enabled) AS live_auto_trade_rows,
    COUNT(*) FILTER (
      WHERE demo_execution_mode <> 'CONFIRM' OR live_execution_mode <> 'CONFIRM'
    ) AS non_confirm_mode_rows
  FROM public.user_trading_settings;

COMMIT;

-- Additional post-migration isolation checks. Run only after the full chain.
BEGIN READ ONLY;

-- Must return no rows: RLS must cover both legacy and provider-neutral additions.
SELECT expected.table_name AS missing_or_unprotected_table
  FROM (VALUES
    ('exchange_api_credentials'), ('user_exchange_preferences'),
    ('user_exchange_trading_settings'), ('exchange_provider_settings'),
    ('exchange_execution_events'), ('admin_exchange_audit_log'),
    ('user_strategy_settings'), ('admin_binance_demo_test_accounts'),
    ('admin_demo_test_account_events'), ('admin_demo_test_sessions'),
    ('admin_demo_test_authorizations'), ('admin_demo_test_executions'),
    ('admin_demo_test_events'), ('admin_demo_identities'),
    ('admin_demo_exchange_credentials'), ('admin_demo_exchange_sessions'),
    ('admin_demo_exchange_authorizations'), ('admin_demo_exchange_executions'),
    ('admin_demo_exchange_audit_events')
  ) AS expected(table_name)
  LEFT JOIN pg_namespace AS ns ON ns.nspname = 'public'
  LEFT JOIN pg_class AS relation
    ON relation.relnamespace = ns.oid AND relation.relname = expected.table_name
 WHERE relation.oid IS NULL OR NOT relation.relrowsecurity;

-- Must be zero. Compare encrypted values inside the database; output counts only.
SELECT COUNT(*) AS missing_or_mismatched_binance_credential_copies
  FROM public.binance_api_credentials AS legacy
  LEFT JOIN public.exchange_api_credentials AS copied
    ON copied.user_id = legacy.user_id AND copied.exchange = 'BINANCE'
   AND copied.environment = legacy.environment
 WHERE copied.user_id IS NULL
    OR copied.api_key_ciphertext IS DISTINCT FROM legacy.api_key_ciphertext
    OR copied.api_secret_ciphertext IS DISTINCT FROM legacy.api_secret_ciphertext;

-- Must return no rows. Include inherited PUBLIC and sequence privileges.
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('exchange_api_credentials', 'admin_demo_exchange_credentials',
       'admin_demo_exchange_executions', 'admin_demo_exchange_authorizations',
       'admin_demo_exchange_sessions', 'admin_demo_exchange_audit_events',
       'admin_demo_identities')
   AND grantee IN ('PUBLIC', 'anon', 'authenticated');

SELECT sequence_name, principal AS browser_sequence_access
  FROM (VALUES
    ('admin_demo_exchange_credentials_id_seq'), ('admin_demo_exchange_sessions_id_seq'),
    ('admin_demo_exchange_authorizations_id_seq'), ('admin_demo_exchange_executions_id_seq'),
    ('admin_demo_exchange_audit_events_id_seq')
  ) AS sequences(sequence_name)
 CROSS JOIN (VALUES ('anon'), ('authenticated')) AS roles(principal)
 WHERE has_sequence_privilege(principal, 'public.' || sequence_name, 'USAGE,SELECT,UPDATE');

COMMIT;

-- POST-MIGRATION CHECKS: run only after the approved sequence completes.
BEGIN READ ONLY;

SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE COALESCE(substring(name FROM '^([0-9]{12})'), version::TEXT) IN (
       '202611100003', '202611100004', '202611110001', '202611110002',
       '202611110003', '202611110004', '202611110005', '202611110006',
       '202611110007', '202611140001'
 )
 ORDER BY version;

-- Run the following zero-violation checks before any Admin identity or credential
-- provisioning. The separate provisioning queries below are expected to return
-- approved, explicitly enabled state only after operator authorization.
-- Compare these observed counts with the affected-row formulas captured above.
SELECT 'exchange_provider_settings' AS table_name, COUNT(*) AS observed_post_migration_rows
  FROM public.exchange_provider_settings
UNION ALL
SELECT 'user_exchange_trading_settings', COUNT(*) FROM public.user_exchange_trading_settings
UNION ALL
SELECT 'user_strategy_settings', COUNT(*) FROM public.user_strategy_settings
UNION ALL
SELECT 'user_trading_settings', COUNT(*) FROM public.user_trading_settings;

SELECT 'provider_access_enabled' AS check_name, COUNT(*) AS violating_rows
  FROM public.exchange_provider_settings
 WHERE customer_enabled OR demo_enabled OR testnet_enabled OR live_enabled
UNION ALL
SELECT 'exchange_automation_enabled', COUNT(*)
  FROM public.user_exchange_trading_settings
 WHERE auto_trade_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'strategy_automation_enabled', COUNT(*)
  FROM public.user_strategy_settings
 WHERE enabled OR auto_execution_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'legacy_automation_enabled', COUNT(*)
  FROM public.user_trading_settings
 WHERE demo_auto_trade_enabled OR live_auto_trade_enabled
    OR demo_execution_mode <> 'CONFIRM'
    OR live_execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'admin_demo_identity_active', COUNT(*)
  FROM public.admin_demo_identities
 WHERE is_active
UNION ALL
SELECT 'admin_demo_credential_enabled', COUNT(*)
  FROM public.admin_demo_exchange_credentials
 WHERE is_enabled
UNION ALL
SELECT 'admin_demo_session_enabled_or_automatic', COUNT(*)
  FROM public.admin_demo_exchange_sessions
 WHERE is_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'admin_demo_execution_enabled_or_automatic', COUNT(*)
  FROM public.admin_demo_exchange_executions
 WHERE is_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'admin_demo_provider_environment_mismatch', COUNT(*)
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
 );

-- Complete the post-migration safe-default snapshot before any provisioning.
COMMIT;

-- Run after explicit operator provisioning, separately from the safe-default checks.
-- Confirm that only the approved Staging Admin identity/provider is active; no
-- credentials or ciphertext are selected here. Re-run only this section after
-- provisioning, since the safe-default checks above intentionally expect zero.
BEGIN READ ONLY;

SELECT admin_user_id
  FROM public.admin_demo_identities
 WHERE admin_scope = 'ADMIN' AND is_active
 ORDER BY admin_user_id;

SELECT provider, environment, COUNT(*) AS enabled_credential_rows
  FROM public.admin_demo_exchange_credentials
 WHERE is_enabled AND revoked_at IS NULL
 GROUP BY provider, environment
 ORDER BY provider, environment;

COMMIT;

-- The single authorization RPC must be service-role-only; browser grants must be absent.
BEGIN READ ONLY;

SELECT routine_name, grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE specific_schema = 'public'
   AND routine_name = 'authorize_admin_demo_exchange_action'
 ORDER BY grantee, privilege_type;

SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN (
       'admin_demo_identities', 'admin_demo_exchange_credentials',
       'admin_demo_exchange_sessions', 'admin_demo_exchange_authorizations',
       'admin_demo_exchange_executions', 'admin_demo_exchange_audit_events'
   )
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
 ORDER BY table_name, grantee, privilege_type;

-- All mutation privilege booleans must be false. All three relations must
-- retain their append-only trigger, and all audit parent FKs must be RESTRICT.
SELECT r.relation_name,
       has_table_privilege('service_role', r.relation_name, 'UPDATE,DELETE,TRUNCATE,TRIGGER') AS service_role_can_mutate,
       EXISTS (
         SELECT FROM pg_trigger AS t
          WHERE t.tgrelid = to_regclass(r.relation_name)
            AND t.tgfoid = 'public.reject_admin_demo_audit_changes()'::regprocedure
            AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
       ) AS append_only_trigger_enabled,
       NOT EXISTS (
         SELECT FROM pg_constraint AS c
          WHERE c.conrelid = to_regclass(r.relation_name)
            AND c.contype = 'f' AND c.confdeltype <> 'r'
       ) AS parent_deletes_restricted
  FROM (VALUES ('public.admin_demo_exchange_audit_events'),
               ('public.admin_demo_test_events'),
               ('public.admin_demo_test_account_events')) AS r(relation_name);

COMMIT;
