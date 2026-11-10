ALTER TABLE public.binance_api_credentials
    ADD COLUMN IF NOT EXISTS environment VARCHAR(8) NOT NULL DEFAULT 'LIVE';

ALTER TABLE public.binance_api_credentials
    DROP CONSTRAINT IF EXISTS binance_api_credentials_environment_check,
    DROP CONSTRAINT IF EXISTS binance_api_credentials_pkey;

ALTER TABLE public.binance_api_credentials
    ADD CONSTRAINT binance_api_credentials_environment_check
        CHECK (environment IN ('DEMO', 'LIVE')),
    ADD CONSTRAINT binance_api_credentials_pkey PRIMARY KEY (user_id, environment);

ALTER TABLE public.user_trading_settings
    ADD COLUMN IF NOT EXISTS active_environment VARCHAR(8) NOT NULL DEFAULT 'DEMO',
    ADD COLUMN IF NOT EXISTS demo_execution_mode VARCHAR(16) NOT NULL DEFAULT 'CONFIRM',
    ADD COLUMN IF NOT EXISTS live_execution_mode VARCHAR(16) NOT NULL DEFAULT 'CONFIRM',
    ADD COLUMN IF NOT EXISTS demo_auto_trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS live_auto_trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS demo_kill_switch_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS live_kill_switch_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.user_trading_settings
    DROP CONSTRAINT IF EXISTS user_trading_settings_active_environment_check,
    DROP CONSTRAINT IF EXISTS user_trading_settings_demo_execution_mode_check,
    DROP CONSTRAINT IF EXISTS user_trading_settings_live_execution_mode_check;

ALTER TABLE public.user_trading_settings
    ADD CONSTRAINT user_trading_settings_active_environment_check
        CHECK (active_environment IN ('DEMO', 'LIVE')),
    ADD CONSTRAINT user_trading_settings_demo_execution_mode_check
        CHECK (demo_execution_mode IN ('CONFIRM', 'AUTOMATIC')),
    ADD CONSTRAINT user_trading_settings_live_execution_mode_check
        CHECK (live_execution_mode IN ('CONFIRM', 'AUTOMATIC'));

UPDATE public.user_trading_settings
   SET live_kill_switch_enabled = TRUE
 WHERE kill_switch_enabled = TRUE;

ALTER TABLE public.trade_executions
    ADD COLUMN IF NOT EXISTS environment VARCHAR(8) NOT NULL DEFAULT 'LIVE';

ALTER TABLE public.trade_executions
    DROP CONSTRAINT IF EXISTS trade_executions_environment_check,
    DROP CONSTRAINT IF EXISTS trade_executions_user_id_signal_id_key,
    DROP CONSTRAINT IF EXISTS trade_executions_user_signal_environment_key;

ALTER TABLE public.trade_executions
    ADD CONSTRAINT trade_executions_environment_check
        CHECK (environment IN ('DEMO', 'LIVE')),
    ADD CONSTRAINT trade_executions_user_signal_environment_key
        UNIQUE (user_id, signal_id, environment);

CREATE INDEX IF NOT EXISTS trade_executions_user_environment_created_idx
    ON public.trade_executions (user_id, environment, created_at DESC);

ALTER TABLE public.binance_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_trading_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS binance_api_credentials_self ON public.binance_api_credentials;
CREATE POLICY binance_api_credentials_self
    ON public.binance_api_credentials FOR ALL TO authenticated
    USING (
        CASE WHEN (auth.jwt() ->> 'app_user_id') ~ '^[0-9]+$'
        THEN (auth.jwt() ->> 'app_user_id')::INTEGER = user_id ELSE FALSE END
    )
    WITH CHECK (
        CASE WHEN (auth.jwt() ->> 'app_user_id') ~ '^[0-9]+$'
        THEN (auth.jwt() ->> 'app_user_id')::INTEGER = user_id ELSE FALSE END
    );

REVOKE ALL ON public.binance_api_credentials FROM anon, authenticated;
REVOKE ALL ON public.user_trading_settings, public.trade_executions FROM anon, authenticated;
