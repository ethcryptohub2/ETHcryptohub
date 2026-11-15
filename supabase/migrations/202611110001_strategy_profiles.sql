DO $$
BEGIN
    IF to_regclass('public.user_exchange_trading_settings') IS NULL
       OR to_regclass('public.exchange_provider_settings') IS NULL THEN
        RAISE EXCEPTION 'Apply 202611100003_multi_exchange_foundation.sql before this migration.';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.user_strategy_settings (
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    strategy VARCHAR(24) NOT NULL CHECK (strategy IN ('STANDARD', 'HIGH_RISK_SCALPING')),
    exchange VARCHAR(16) NOT NULL CHECK (exchange IN ('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE')),
    environment VARCHAR(8) NOT NULL CHECK (environment IN ('DEMO', 'TESTNET', 'LIVE')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'CONFIRM'
        CHECK (execution_mode IN ('CONFIRM', 'AUTOMATIC')),
    risk_percentage NUMERIC(5, 2) NOT NULL DEFAULT 1
        CHECK (risk_percentage > 0 AND risk_percentage <= 100),
    order_size_mode VARCHAR(16) NOT NULL DEFAULT 'RISK_BASED'
        CHECK (order_size_mode IN ('FIXED', 'RISK_BASED')),
    fixed_notional_usdt NUMERIC(24, 8) NOT NULL DEFAULT 100
        CHECK (fixed_notional_usdt > 0),
    leverage INTEGER NOT NULL DEFAULT 1 CHECK (leverage BETWEEN 1 AND 125),
    max_open_positions INTEGER CHECK (max_open_positions BETWEEN 1 AND 100),
    max_daily_loss_percent NUMERIC(5, 2)
        CHECK (max_daily_loss_percent > 0 AND max_daily_loss_percent <= 100),
    auto_execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    emergency_stop_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, strategy),
    CHECK (
      (exchange = 'GATE' AND environment IN ('TESTNET', 'LIVE'))
      OR (exchange <> 'GATE' AND environment IN ('DEMO', 'LIVE'))
    ),
    CHECK (auto_execution_enabled = FALSE OR execution_mode = 'AUTOMATIC'),
    CHECK (
      NOT enabled OR (
        max_open_positions IS NOT NULL
        AND max_daily_loss_percent IS NOT NULL
      )
    ),
    CHECK (environment <> 'LIVE' OR enabled = FALSE)
);

INSERT INTO public.user_strategy_settings (
    user_id, strategy, exchange, environment, enabled, execution_mode, risk_percentage,
    order_size_mode, fixed_notional_usdt, leverage, auto_execution_enabled,
    emergency_stop_enabled, updated_at
)
SELECT settings.user_id,
       'STANDARD',
       'BINANCE',
       settings.active_environment,
       FALSE,
       CASE settings.active_environment
         WHEN 'DEMO' THEN settings.demo_execution_mode
         ELSE settings.live_execution_mode
       END,
       settings.risk_percentage,
       settings.order_size_mode,
       settings.fixed_notional_usdt,
       settings.default_leverage,
       CASE settings.active_environment
         WHEN 'DEMO' THEN settings.demo_auto_trade_enabled
         ELSE FALSE
       END,
       CASE settings.active_environment
         WHEN 'DEMO' THEN settings.demo_kill_switch_enabled
         ELSE settings.live_kill_switch_enabled
       END,
       settings.updated_at
  FROM public.user_trading_settings AS settings
ON CONFLICT (user_id, strategy) DO NOTHING;

INSERT INTO public.user_strategy_settings (user_id, strategy, exchange, environment)
SELECT users.id, 'STANDARD', 'BINANCE', 'DEMO'
  FROM public.users AS users
 WHERE NOT EXISTS (
   SELECT 1 FROM public.user_strategy_settings AS settings
    WHERE settings.user_id = users.id AND settings.strategy = 'STANDARD'
 )
ON CONFLICT (user_id, strategy) DO NOTHING;

INSERT INTO public.user_strategy_settings (user_id, strategy, exchange, environment)
SELECT users.id, 'HIGH_RISK_SCALPING', 'BINANCE', 'DEMO'
  FROM public.users AS users
ON CONFLICT (user_id, strategy) DO NOTHING;

ALTER TABLE public.trade_executions
    ADD COLUMN IF NOT EXISTS strategy VARCHAR(24) NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN IF NOT EXISTS protection_status VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN IF NOT EXISTS tp1_price NUMERIC(30, 12),
    ADD COLUMN IF NOT EXISTS tp2_price NUMERIC(30, 12),
    ADD COLUMN IF NOT EXISTS tp3_price NUMERIC(30, 12),
    ADD COLUMN IF NOT EXISTS trailing_percent NUMERIC(5, 2) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS trailing_extreme_price NUMERIC(30, 12),
    ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(30, 12),
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

UPDATE public.trade_executions AS execution
   SET strategy = CASE signal.scanner_type
     WHEN 'HIGH_RISK' THEN 'HIGH_RISK_SCALPING'
     ELSE 'STANDARD'
   END
  FROM public.market_signals AS signal
 WHERE signal.id = execution.signal_id;

ALTER TABLE public.trade_executions
    DROP CONSTRAINT IF EXISTS trade_executions_strategy_check,
    DROP CONSTRAINT IF EXISTS trade_executions_protection_status_check;

ALTER TABLE public.trade_executions
    ADD CONSTRAINT trade_executions_strategy_check
        CHECK (strategy IN ('STANDARD', 'HIGH_RISK_SCALPING')),
    ADD CONSTRAINT trade_executions_protection_status_check
        CHECK (protection_status IN ('UNKNOWN', 'PENDING', 'PROTECTED', 'TRAILING', 'FAILED', 'CLOSED'));

CREATE INDEX IF NOT EXISTS user_strategy_settings_enabled_idx
    ON public.user_strategy_settings (user_id, strategy, exchange, environment)
    WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS trade_executions_strategy_created_idx
    ON public.trade_executions (user_id, strategy, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_executions_open_strategy_idx
    ON public.trade_executions (user_id, strategy, exchange, environment)
    WHERE execution_status IN ('EXECUTING', 'ENTRY_FILLED', 'PROTECTED', 'PROTECTION_FAILED');

ALTER TABLE public.user_strategy_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_strategy_settings FROM anon, authenticated;

DROP POLICY IF EXISTS user_strategy_settings_self ON public.user_strategy_settings;
CREATE POLICY user_strategy_settings_self
    ON public.user_strategy_settings FOR ALL TO authenticated
    USING (
        CASE WHEN (auth.jwt() ->> 'app_user_id') ~ '^[0-9]+$'
        THEN (auth.jwt() ->> 'app_user_id')::INTEGER = user_id ELSE FALSE END
    )
    WITH CHECK (
        CASE WHEN (auth.jwt() ->> 'app_user_id') ~ '^[0-9]+$'
        THEN (auth.jwt() ->> 'app_user_id')::INTEGER = user_id ELSE FALSE END
    );
