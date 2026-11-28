SELECT
    to_regclass('public.binance_demo_reconciliation_records') IS NOT NULL
    AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_executions' AND column_name = 'exit_reason'
    )
    AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_executions' AND column_name = 'funding_fee_usdt'
    )
    AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_executions' AND column_name = 'net_realized_pnl'
    )
    AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trade_executions' AND column_name = 'reconciliation_status'
    ) AS verified;
