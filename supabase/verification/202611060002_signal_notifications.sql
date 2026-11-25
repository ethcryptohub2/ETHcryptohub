-- Read-only verification for migration 202611060002_signal_notifications.sql.
SELECT to_regclass('public.market_signals') AS market_signals,
       to_regclass('public.signal_events') AS signal_events;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'market_signals'
   AND column_name IN ('id', 'signal_key', 'symbol', 'timeframe', 'side', 'setup_score', 'entry_price', 'status');
