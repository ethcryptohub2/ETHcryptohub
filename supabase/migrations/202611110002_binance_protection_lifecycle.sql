DO $$
BEGIN
    IF to_regclass('public.trade_executions') IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'trade_executions'
            AND column_name = 'strategy'
       ) THEN
        RAISE EXCEPTION 'Apply migrations 202611100003 and 202611110001 before this migration.';
    END IF;
END;
$$;

ALTER TABLE public.trade_executions
    ADD COLUMN IF NOT EXISTS trailing_order_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS exit_order_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS tp1_reached_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tp2_reached_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS exit_client_order_id VARCHAR(36),
    ADD COLUMN IF NOT EXISTS reconcile_lock_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconcile_lock_token UUID,
    ADD COLUMN IF NOT EXISTS sl_client_algo_id VARCHAR(36),
    ADD COLUMN IF NOT EXISTS tp_client_algo_id VARCHAR(36),
    ADD COLUMN IF NOT EXISTS trailing_client_algo_id VARCHAR(36);

ALTER TABLE public.trade_executions
    DROP CONSTRAINT IF EXISTS trade_executions_execution_status_check,
    ADD CONSTRAINT trade_executions_execution_status_check
        CHECK (execution_status IN (
            'AWAITING_CONFIRMATION', 'EXECUTING', 'ENTRY_FILLED', 'PROTECTED',
            'FAILED', 'PROTECTION_FAILED', 'REJECTED', 'CANCELLED', 'CLOSED'
        ));

CREATE INDEX IF NOT EXISTS trade_executions_open_protection_idx
    ON public.trade_executions (environment, user_id, created_at)
    WHERE execution_status IN ('ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED');
