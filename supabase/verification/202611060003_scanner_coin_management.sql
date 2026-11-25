-- Read-only verification for migration 202611060003_scanner_coin_management.sql.
SELECT to_regclass('public.scanner_coin_configs') AS scanner_coin_configs,
       to_regclass('public.scanner_sync_state') AS scanner_sync_state;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'scanner_coin_configs'
   AND column_name IN ('symbol', 'exchange', 'is_enabled', 'is_admin_disabled');
