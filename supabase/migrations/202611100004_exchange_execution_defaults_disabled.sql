DO $$
BEGIN
    IF to_regclass('public.exchange_provider_settings') IS NULL
       OR to_regclass('public.user_exchange_trading_settings') IS NULL THEN
        RAISE EXCEPTION 'Apply 202611100003_multi_exchange_foundation.sql before this migration.';
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
