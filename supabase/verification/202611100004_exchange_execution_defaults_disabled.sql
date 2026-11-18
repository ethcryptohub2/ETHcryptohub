-- Read-only verification. Every returned count must be zero.
SELECT 'provider_access_enabled' AS check_name, COUNT(*) AS violating_rows
  FROM public.exchange_provider_settings
 WHERE customer_enabled OR demo_enabled OR testnet_enabled OR live_enabled
UNION ALL
SELECT 'exchange_automation_enabled', COUNT(*)
  FROM public.user_exchange_trading_settings
 WHERE auto_trade_enabled OR execution_mode <> 'CONFIRM';
