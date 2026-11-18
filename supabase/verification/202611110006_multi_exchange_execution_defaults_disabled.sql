-- Read-only verification. Every returned count must be zero.
SELECT 'provider_access_enabled' AS check_name, COUNT(*) AS violating_rows
  FROM public.exchange_provider_settings
 WHERE customer_enabled OR demo_enabled OR testnet_enabled OR live_enabled
UNION ALL
SELECT 'exchange_automation_enabled', COUNT(*)
  FROM public.user_exchange_trading_settings
 WHERE auto_trade_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'strategy_enabled_or_automatic', COUNT(*)
  FROM public.user_strategy_settings
 WHERE enabled OR auto_execution_enabled OR execution_mode <> 'CONFIRM'
UNION ALL
SELECT 'legacy_automation_enabled', COUNT(*)
  FROM public.user_trading_settings
 WHERE demo_auto_trade_enabled OR live_auto_trade_enabled
    OR demo_execution_mode <> 'CONFIRM'
    OR live_execution_mode <> 'CONFIRM';
