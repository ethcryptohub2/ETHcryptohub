-- DISPOSABLE LOCAL POSTGRESQL ONLY. Never run this write fixture against Staging.
-- Assumes a synthetic ledger, fixture users, and Supabase-compatible fixture roles.
BEGIN;

DO $$
DECLARE
  browser_role text;
  relation_name text;
  rpc_name text;
  relations text[] := ARRAY[
    'exchange_api_credentials', 'user_exchange_preferences', 'user_exchange_trading_settings',
    'exchange_provider_settings', 'exchange_execution_events', 'admin_exchange_audit_log',
    'user_strategy_settings', 'admin_binance_demo_test_accounts', 'admin_demo_test_account_events',
    'admin_demo_test_sessions', 'admin_demo_test_authorizations', 'admin_demo_test_executions',
    'admin_demo_test_events', 'admin_demo_identities', 'admin_demo_exchange_credentials',
    'admin_demo_exchange_sessions', 'admin_demo_exchange_authorizations',
    'admin_demo_exchange_executions', 'admin_demo_exchange_audit_events', 'auth_password_reset_codes'
  ];
  rpcs text[] := ARRAY[
    'public.authorize_admin_demo_test_action(integer,bigint,bigint,text)',
    'public.authorize_admin_demo_exchange_action(integer,text,bigint,bigint,public.admin_demo_provider,text,text)'
  ];
BEGIN
  FOREACH relation_name IN ARRAY relations LOOP
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid = to_regclass('public.' || relation_name) AND relrowsecurity) THEN
      RAISE EXCEPTION 'Missing or unprotected relation %', relation_name;
    END IF;
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(browser_role, 'public.' || relation_name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Unexpected browser table grant on %', relation_name;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH rpc_name IN ARRAY rpcs LOOP
    IF NOT has_function_privilege('service_role', rpc_name, 'EXECUTE')
       OR has_function_privilege('anon', rpc_name, 'EXECUTE')
       OR has_function_privilege('authenticated', rpc_name, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected authorization RPC privileges for %', rpc_name;
    END IF;
  END LOOP;
  IF (SELECT COUNT(*) FROM public.exchange_provider_settings) <> 5
     OR EXISTS (SELECT FROM public.exchange_provider_settings WHERE customer_enabled OR demo_enabled OR testnet_enabled OR live_enabled)
     OR EXISTS (SELECT FROM public.user_exchange_trading_settings WHERE auto_trade_enabled OR execution_mode <> 'CONFIRM')
     OR EXISTS (SELECT FROM public.user_strategy_settings WHERE enabled OR auto_execution_enabled OR execution_mode <> 'CONFIRM')
     OR EXISTS (SELECT FROM public.user_trading_settings WHERE demo_auto_trade_enabled OR live_auto_trade_enabled OR demo_execution_mode <> 'CONFIRM' OR live_execution_mode <> 'CONFIRM') THEN
    RAISE EXCEPTION 'Unexpected execution defaults';
  END IF;
  IF (SELECT COUNT(*) FROM public.exchange_api_credentials
       WHERE exchange = 'BINANCE' AND environment = 'DEMO'
       AND api_key_ciphertext = 'synthetic-ciphertext-key'
       AND api_secret_ciphertext = 'synthetic-ciphertext-secret'
       AND updated_at = '2025-01-01T00:00:00Z'::timestamptz
       AND created_at > updated_at) <> 1 THEN
    RAISE EXCEPTION 'Synthetic ciphertext backfill or timestamp semantics failed';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_demo_exchange_audit_events', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.admin_demo_exchange_audit_events', 'INSERT')
     OR has_table_privilege('service_role', 'public.admin_demo_exchange_audit_events', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
     OR has_table_privilege('service_role', 'public.admin_demo_test_account_events', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
     OR has_table_privilege('service_role', 'public.admin_demo_test_events', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
     OR has_sequence_privilege('service_role','public.admin_demo_exchange_audit_events_id_seq','UPDATE') THEN
    RAISE EXCEPTION 'Append-only audit grants are incorrect';
  END IF;
  IF EXISTS (
    SELECT FROM pg_constraint
     WHERE conrelid IN ('public.admin_demo_exchange_audit_events'::regclass,
                       'public.admin_demo_test_events'::regclass,
                       'public.admin_demo_test_account_events'::regclass)
       AND contype = 'f' AND confdeltype <> 'r'
  ) THEN
    RAISE EXCEPTION 'An audit relation can lose records through a parent mutation';
  END IF;
END
$$;

DO $$
DECLARE
  actor_id integer;
  other_id integer;
  fixture_credential_id bigint;
  fixture_session_id bigint;
  fixture_authorization_id bigint;
BEGIN
  SELECT id INTO STRICT actor_id FROM public.users WHERE email = 'fixture-admin@example.invalid';
  INSERT INTO public.users(email,password_hash,role)
    VALUES ('fixture-other-admin@example.invalid','fixture-only','admin') RETURNING id INTO other_id;
  INSERT INTO public.admin_demo_identities(admin_user_id,is_active) VALUES (actor_id,true), (other_id,true);
  INSERT INTO public.admin_demo_exchange_credentials(
      admin_user_id,provider,environment,api_key_ciphertext,secret_key_ciphertext,owner_confirmed_at,is_enabled)
    VALUES (actor_id,'BYBIT','DEMO','fixture-key','fixture-secret',CURRENT_TIMESTAMP,true)
    RETURNING id INTO fixture_credential_id;
  INSERT INTO public.admin_demo_exchange_sessions(admin_user_id,provider,environment,credential_id,is_enabled)
    VALUES (actor_id,'BYBIT','DEMO',fixture_credential_id,true) RETURNING id INTO fixture_session_id;
  INSERT INTO public.admin_demo_exchange_authorizations(admin_user_id,provider,environment,session_id,permitted_actions,expires_at)
    VALUES (actor_id,'BYBIT','DEMO',fixture_session_id,ARRAY['START_TEST','RECONCILE'],CURRENT_TIMESTAMP + INTERVAL '5 minutes')
    RETURNING id INTO fixture_authorization_id;

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  IF public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','START_TEST') THEN
    RAISE EXCEPTION 'Wrong role accepted';
  END IF;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  IF public.authorize_admin_demo_exchange_action(other_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','START_TEST')
     OR public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'GATE','TESTNET','START_TEST')
     OR public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','RECONCILE') THEN
    RAISE EXCEPTION 'Cross-actor, wrong provider, or premature reconciliation accepted';
  END IF;
  IF NOT public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','START_TEST') THEN
    RAISE EXCEPTION 'Bound one-time authorization failed';
  END IF;
  IF public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','START_TEST') THEN
    RAISE EXCEPTION 'Authorization replay accepted';
  END IF;
  IF NOT public.authorize_admin_demo_exchange_action(actor_id,'ADMIN',fixture_session_id,fixture_authorization_id,'BYBIT','DEMO','RECONCILE') THEN
    RAISE EXCEPTION 'Bound reconciliation failed';
  END IF;
  IF (SELECT COUNT(*) FROM public.admin_demo_exchange_audit_events WHERE session_id = fixture_session_id) <> 2 THEN
    RAISE EXCEPTION 'Unexpected number of action audit records';
  END IF;

  BEGIN
    UPDATE public.admin_demo_exchange_audit_events SET safe_details = '{"edited":true}' WHERE session_id = fixture_session_id;
    RAISE EXCEPTION 'Direct audit update succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    DELETE FROM public.admin_demo_exchange_audit_events WHERE session_id = fixture_session_id;
    RAISE EXCEPTION 'Direct audit delete succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    TRUNCATE TABLE public.admin_demo_exchange_audit_events;
    RAISE EXCEPTION 'Direct audit truncate succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    TRUNCATE TABLE public.admin_demo_test_events;
    RAISE EXCEPTION 'Legacy audit truncate succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    TRUNCATE TABLE public.admin_demo_test_account_events;
    RAISE EXCEPTION 'Legacy account audit truncate succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    DELETE FROM public.admin_demo_identities WHERE admin_user_id = actor_id;
    RAISE EXCEPTION 'Parent deletion bypassed audit retention';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

ROLLBACK;
