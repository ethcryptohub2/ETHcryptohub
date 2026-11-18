DO $$
BEGIN
    IF to_regclass('public.user_strategy_settings') IS NULL
       OR to_regclass('public.user_trading_settings') IS NULL
       OR to_regclass('public.user_exchange_trading_settings') IS NULL
       OR to_regclass('public.exchange_provider_settings') IS NULL THEN
        RAISE EXCEPTION 'Apply the multi-exchange and strategy-profile migrations before this migration.';
    END IF;
END;
$$;

UPDATE public.exchange_provider_settings
   SET customer_enabled = FALSE,
       demo_enabled = FALSE,
       testnet_enabled = FALSE,
       live_enabled = FALSE,
       updated_at = NOW();

UPDATE public.user_exchange_trading_settings
   SET auto_trade_enabled = FALSE,
       execution_mode = 'CONFIRM',
       updated_at = NOW();

UPDATE public.user_strategy_settings
   SET enabled = FALSE,
       auto_execution_enabled = FALSE,
       execution_mode = 'CONFIRM',
       updated_at = NOW();

UPDATE public.user_trading_settings
   SET demo_auto_trade_enabled = FALSE,
       live_auto_trade_enabled = FALSE,
       demo_execution_mode = 'CONFIRM',
       live_execution_mode = 'CONFIRM',
       updated_at = NOW();
