-- Read-only verification for migration 202611070001_high_risk_scalping.sql.
SELECT to_regclass('public.high_risk_scalping_settings') AS high_risk_scalping_settings,
       to_regclass('public.high_risk_scalping_signals') AS high_risk_scalping_signals;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'high_risk_scalping_signals'
   AND column_name IN ('signal_key', 'symbol', 'timeframe', 'side', 'setup_score', 'lifecycle_status');
