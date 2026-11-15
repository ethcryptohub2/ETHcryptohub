-- Read-only verification for migration 202611110002_binance_protection_lifecycle.sql.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'trade_executions'
   AND column_name IN (
     'trailing_order_id', 'exit_order_id', 'tp1_reached_at', 'tp2_reached_at',
     'last_reconciled_at', 'exit_client_order_id', 'reconcile_lock_until',
     'reconcile_lock_token', 'sl_client_algo_id', 'tp_client_algo_id',
     'trailing_client_algo_id'
   )
 ORDER BY column_name;

SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'trade_executions'
   AND indexname LIKE '%protection%';

SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.trade_executions'::regclass
   AND conname = 'trade_executions_execution_status_check';

SELECT execution_status, COUNT(*) AS execution_count
  FROM public.trade_executions
 GROUP BY execution_status
 ORDER BY execution_status;
