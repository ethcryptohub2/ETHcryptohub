CREATE TABLE IF NOT EXISTS public.exchange_api_credentials (
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    exchange VARCHAR(16) NOT NULL CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    environment VARCHAR(8) NOT NULL CHECK (environment IN ('DEMO', 'TESTNET', 'LIVE')),
    api_key_ciphertext TEXT NOT NULL,
    api_secret_ciphertext TEXT NOT NULL,
    passphrase_ciphertext TEXT,
    api_key_suffix VARCHAR(8),
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, exchange, environment),
    CHECK (
      (exchange = 'GATE' AND environment IN ('TESTNET', 'LIVE'))
      OR (exchange <> 'GATE' AND environment IN ('DEMO', 'LIVE'))
    ),
    CHECK ((exchange IN ('OKX', 'BITGET')) = (passphrase_ciphertext IS NOT NULL))
);

INSERT INTO public.exchange_api_credentials (
    user_id, exchange, environment, api_key_ciphertext, api_secret_ciphertext,
    api_key_suffix, created_at, updated_at
)
SELECT user_id, 'BINANCE', environment, api_key_ciphertext, api_secret_ciphertext,
       NULL, created_at, updated_at
  FROM public.binance_api_credentials
ON CONFLICT (user_id, exchange, environment) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_exchange_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    active_exchange VARCHAR(16) NOT NULL DEFAULT 'BINANCE'
        CHECK (active_exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    active_environment VARCHAR(8) NOT NULL DEFAULT 'DEMO'
        CHECK (active_environment IN ('DEMO', 'TESTNET', 'LIVE')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (active_exchange = 'GATE' AND active_environment IN ('TESTNET', 'LIVE'))
      OR (active_exchange <> 'GATE' AND active_environment IN ('DEMO', 'LIVE'))
    )
);

INSERT INTO public.user_exchange_preferences (user_id, active_exchange, active_environment, updated_at)
SELECT user_id, 'BINANCE', 'DEMO', updated_at
  FROM public.user_trading_settings
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_exchange_trading_settings (
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    exchange VARCHAR(16) NOT NULL CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    environment VARCHAR(8) NOT NULL CHECK (environment IN ('DEMO', 'TESTNET', 'LIVE')),
    order_size_mode VARCHAR(16) NOT NULL DEFAULT 'FIXED'
        CHECK (order_size_mode IN ('FIXED', 'RISK_BASED')),
    fixed_notional_usdt NUMERIC(24, 8) NOT NULL DEFAULT 100 CHECK (fixed_notional_usdt > 0),
    risk_percentage NUMERIC(5, 2) NOT NULL DEFAULT 1 CHECK (risk_percentage > 0 AND risk_percentage <= 5),
    default_leverage INTEGER NOT NULL DEFAULT 1 CHECK (default_leverage BETWEEN 1 AND 125),
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'CONFIRM'
        CHECK (execution_mode IN ('CONFIRM', 'AUTOMATIC')),
    auto_trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    emergency_stop_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, exchange, environment),
    CHECK (
      (exchange = 'GATE' AND environment IN ('TESTNET', 'LIVE'))
      OR (exchange <> 'GATE' AND environment IN ('DEMO', 'LIVE'))
    )
);

INSERT INTO public.user_exchange_trading_settings (
    user_id, exchange, environment, order_size_mode, fixed_notional_usdt,
    risk_percentage, default_leverage, execution_mode, auto_trade_enabled,
    emergency_stop_enabled, updated_at
)
SELECT user_id, 'BINANCE', 'DEMO', order_size_mode, fixed_notional_usdt,
       risk_percentage, default_leverage, 'CONFIRM', FALSE,
       demo_kill_switch_enabled, updated_at
  FROM public.user_trading_settings
ON CONFLICT (user_id, exchange, environment) DO NOTHING;

INSERT INTO public.user_exchange_trading_settings (
    user_id, exchange, environment, order_size_mode, fixed_notional_usdt,
    risk_percentage, default_leverage, execution_mode, auto_trade_enabled,
    emergency_stop_enabled, updated_at
)
SELECT user_id, 'BINANCE', 'LIVE', order_size_mode, fixed_notional_usdt,
       risk_percentage, default_leverage, 'CONFIRM', FALSE,
       live_kill_switch_enabled, updated_at
  FROM public.user_trading_settings
ON CONFLICT (user_id, exchange, environment) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.exchange_provider_settings (
    exchange VARCHAR(16) PRIMARY KEY
        CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    customer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    demo_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    testnet_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    adapter_version VARCHAR(32) NOT NULL DEFAULT 'unverified',
    demo_verified_at TIMESTAMPTZ,
    testnet_verified_at TIMESTAMPTZ,
    live_approved_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    last_error TEXT,
    updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (NOT live_enabled OR live_approved_at IS NOT NULL)
);

INSERT INTO public.exchange_provider_settings (exchange, customer_enabled, demo_enabled, adapter_version)
VALUES
    ('BINANCE', FALSE, FALSE, 'binance-futures-v1'),
    ('BYBIT', FALSE, FALSE, 'unverified'),
    ('OKX', FALSE, FALSE, 'unverified'),
    ('BITGET', FALSE, FALSE, 'unverified'),
    ('GATE', FALSE, FALSE, 'unverified')
ON CONFLICT (exchange) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.exchange_execution_events (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    admin_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    exchange VARCHAR(16) NOT NULL CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    environment VARCHAR(8) NOT NULL CHECK (environment IN ('DEMO', 'TESTNET')),
    event_type VARCHAR(48) NOT NULL,
    status VARCHAR(24) NOT NULL,
    symbol VARCHAR(48),
    exchange_order_id VARCHAR(128),
    client_order_id VARCHAR(128),
    safe_details JSONB NOT NULL DEFAULT '{}'::JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (exchange = 'GATE' AND environment = 'TESTNET')
      OR (exchange <> 'GATE' AND environment = 'DEMO')
    )
);

CREATE INDEX IF NOT EXISTS exchange_execution_events_admin_created_idx
    ON public.exchange_execution_events (admin_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_exchange_audit_log (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    admin_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    exchange VARCHAR(16) NOT NULL CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    action VARCHAR(48) NOT NULL,
    previous_value JSONB NOT NULL DEFAULT '{}'::JSONB,
    new_value JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.trade_executions
    ADD COLUMN IF NOT EXISTS exchange VARCHAR(16) NOT NULL DEFAULT 'BINANCE';

ALTER TABLE public.trade_executions
    DROP CONSTRAINT IF EXISTS trade_executions_environment_check,
    DROP CONSTRAINT IF EXISTS trade_executions_user_id_signal_id_key,
    DROP CONSTRAINT IF EXISTS trade_executions_user_signal_environment_key,
    DROP CONSTRAINT IF EXISTS trade_executions_exchange_check,
    DROP CONSTRAINT IF EXISTS trade_executions_environment_exchange_check,
    DROP CONSTRAINT IF EXISTS trade_executions_user_signal_exchange_environment_key;

ALTER TABLE public.trade_executions
    ADD CONSTRAINT trade_executions_exchange_check
        CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    ADD CONSTRAINT trade_executions_environment_check
        CHECK (environment IN ('DEMO', 'TESTNET', 'LIVE')),
    ADD CONSTRAINT trade_executions_environment_exchange_check
        CHECK (
          (exchange = 'GATE' AND environment IN ('TESTNET', 'LIVE'))
          OR (exchange <> 'GATE' AND environment IN ('DEMO', 'LIVE'))
        ),
    ADD CONSTRAINT trade_executions_user_signal_exchange_environment_key
        UNIQUE (user_id, signal_id, exchange, environment);

CREATE INDEX IF NOT EXISTS trade_executions_user_exchange_created_idx
    ON public.trade_executions (user_id, exchange, environment, created_at DESC);

ALTER TABLE public.exchange_api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_exchange_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_exchange_trading_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_exchange_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.exchange_api_credentials, public.user_exchange_preferences,
    public.user_exchange_trading_settings, public.exchange_provider_settings,
    public.exchange_execution_events, public.admin_exchange_audit_log
    FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.exchange_execution_events_id_seq,
    public.admin_exchange_audit_log_id_seq FROM anon, authenticated;
