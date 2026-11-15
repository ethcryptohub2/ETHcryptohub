DO $$
BEGIN
    IF to_regclass('public.binance_api_credentials') IS NULL
       OR to_regclass('public.exchange_api_credentials') IS NULL THEN
        RAISE EXCEPTION 'Apply 202611100002_binance_demo_environments.sql and 202611100003_multi_exchange_foundation.sql before this migration.';
    END IF;
END;
$$;

ALTER TABLE public.binance_api_credentials
    ADD COLUMN IF NOT EXISTS environment_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.exchange_api_credentials
    ADD COLUMN IF NOT EXISTS environment_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
