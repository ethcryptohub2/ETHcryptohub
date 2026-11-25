-- Read-only verification for migration 202611070002_signal_history_performance.sql.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'market_signals'
   AND column_name IN ('scanner_type', 'exchange', 'strategy_name', 'entry_expires_at', 'entry_status', 'actual_entry_price', 'realized_pnl');
