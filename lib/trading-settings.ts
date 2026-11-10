import { query } from './db';
import type { TradingEnvironment } from './binance-futures';

export type TradingSettings = {
  active_environment: TradingEnvironment;
  order_size_mode: 'FIXED' | 'RISK_BASED';
  fixed_notional_usdt: string;
  risk_percentage: string;
  default_leverage: number;
  execution_mode: 'CONFIRM' | 'AUTOMATIC';
  demo_execution_mode: 'CONFIRM' | 'AUTOMATIC';
  live_execution_mode: 'CONFIRM' | 'AUTOMATIC';
  auto_trade_enabled: boolean;
  kill_switch_enabled: boolean;
  demo_auto_trade_enabled: boolean;
  live_auto_trade_enabled: boolean;
  demo_kill_switch_enabled: boolean;
  live_kill_switch_enabled: boolean;
  updated_at: string;
};

const defaults: TradingSettings = {
  active_environment: 'DEMO',
  order_size_mode: 'FIXED',
  fixed_notional_usdt: '100',
  risk_percentage: '1',
  default_leverage: 1,
  execution_mode: 'CONFIRM',
  demo_execution_mode: 'CONFIRM',
  live_execution_mode: 'CONFIRM',
  auto_trade_enabled: false,
  kill_switch_enabled: false,
  demo_auto_trade_enabled: false,
  live_auto_trade_enabled: false,
  demo_kill_switch_enabled: false,
  live_kill_switch_enabled: false,
  updated_at: new Date(0).toISOString(),
};

export async function getTradingSettings(userId: number): Promise<TradingSettings> {
  await query(
    `INSERT INTO public.user_trading_settings (user_id)
     VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await query<TradingSettings>(
    `SELECT active_environment, order_size_mode, fixed_notional_usdt::TEXT, risk_percentage::TEXT,
            default_leverage, demo_execution_mode, live_execution_mode, demo_auto_trade_enabled, live_auto_trade_enabled,
            demo_kill_switch_enabled, live_kill_switch_enabled, updated_at
       FROM public.user_trading_settings WHERE user_id = $1`,
    [userId],
  );
  const settings = result.rows[0] ?? defaults;
  return {
    ...settings,
    execution_mode: settings.active_environment === 'DEMO'
      ? settings.demo_execution_mode
      : settings.live_execution_mode,
    auto_trade_enabled: settings.active_environment === 'DEMO'
      ? settings.demo_auto_trade_enabled
      : settings.live_auto_trade_enabled,
    kill_switch_enabled: settings.active_environment === 'DEMO'
      ? settings.demo_kill_switch_enabled
      : settings.live_kill_switch_enabled,
  };
}

export async function setActiveTradingEnvironment(userId: number, environment: TradingEnvironment) {
  await query(
    `INSERT INTO public.user_trading_settings (user_id, active_environment)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       active_environment = EXCLUDED.active_environment,
       updated_at = NOW()`,
    [userId, environment],
  );
  return getTradingSettings(userId);
}

export async function updateTradingSettings(
  userId: number,
  environment: TradingEnvironment,
  settings: Pick<TradingSettings, 'order_size_mode' | 'fixed_notional_usdt' | 'risk_percentage' | 'default_leverage' | 'execution_mode'>,
) {
  const activeSettings = await getTradingSettings(userId);
  if (activeSettings.active_environment !== environment) {
    throw new Error('The active environment changed. Reload trading settings and retry.');
  }
  await query(
    `INSERT INTO public.user_trading_settings (
       user_id, order_size_mode, fixed_notional_usdt, risk_percentage,
       default_leverage, execution_mode, demo_execution_mode, live_execution_mode, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $6 = 'AUTOMATIC' THEN 'AUTOMATIC' ELSE 'CONFIRM' END,
               'CONFIRM', NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       order_size_mode = EXCLUDED.order_size_mode,
       fixed_notional_usdt = EXCLUDED.fixed_notional_usdt,
       risk_percentage = EXCLUDED.risk_percentage,
       default_leverage = EXCLUDED.default_leverage,
       execution_mode = EXCLUDED.execution_mode,
       live_execution_mode = CASE WHEN user_trading_settings.active_environment = $7 AND $7 = 'LIVE' THEN EXCLUDED.execution_mode ELSE user_trading_settings.live_execution_mode END,
       demo_execution_mode = CASE WHEN user_trading_settings.active_environment = $7 AND $7 = 'DEMO' THEN EXCLUDED.demo_execution_mode ELSE user_trading_settings.demo_execution_mode END,
       updated_at = NOW()`,
    [
      userId,
      settings.order_size_mode,
      settings.fixed_notional_usdt,
      settings.risk_percentage,
      settings.default_leverage,
      settings.execution_mode,
      environment,
    ],
  );
  return getTradingSettings(userId);
}

export async function setAutoTradeEnabled(userId: number, environment: TradingEnvironment, enabled: boolean) {
  await query(
    `INSERT INTO public.user_trading_settings (
       user_id, demo_auto_trade_enabled, demo_kill_switch_enabled,
       live_auto_trade_enabled, live_kill_switch_enabled, live_trading_acknowledged_at
     ) VALUES (
       $1, CASE WHEN $2 = 'DEMO' THEN $3 ELSE FALSE END, FALSE,
       CASE WHEN $2 = 'LIVE' THEN $3 ELSE FALSE END, FALSE,
       CASE WHEN $2 = 'LIVE' AND $3 THEN NOW() ELSE NULL END
     )
     ON CONFLICT (user_id) DO UPDATE SET
       demo_auto_trade_enabled = CASE WHEN $2 = 'DEMO' THEN $3 ELSE user_trading_settings.demo_auto_trade_enabled END,
       demo_kill_switch_enabled = CASE WHEN $2 = 'DEMO' AND $3 THEN FALSE ELSE user_trading_settings.demo_kill_switch_enabled END,
       live_auto_trade_enabled = CASE WHEN $2 = 'LIVE' THEN $3 ELSE user_trading_settings.live_auto_trade_enabled END,
       live_kill_switch_enabled = CASE WHEN $2 = 'LIVE' AND $3 THEN FALSE ELSE user_trading_settings.live_kill_switch_enabled END,
       live_trading_acknowledged_at = CASE WHEN $2 = 'LIVE' AND $3 THEN NOW() ELSE user_trading_settings.live_trading_acknowledged_at END,
       updated_at = NOW()`,
    [userId, environment, enabled],
  );
  return getTradingSettings(userId);
}

export async function activateKillSwitch(userId: number, environment: TradingEnvironment) {
  await query(
    `INSERT INTO public.user_trading_settings (
       user_id, demo_auto_trade_enabled, demo_kill_switch_enabled,
       live_auto_trade_enabled, live_kill_switch_enabled
     ) VALUES (
       $1, FALSE, $2 = 'DEMO', FALSE, $2 = 'LIVE'
     )
     ON CONFLICT (user_id) DO UPDATE SET
       demo_auto_trade_enabled = CASE WHEN $2 = 'DEMO' THEN FALSE ELSE user_trading_settings.demo_auto_trade_enabled END,
       demo_kill_switch_enabled = CASE WHEN $2 = 'DEMO' THEN TRUE ELSE user_trading_settings.demo_kill_switch_enabled END,
       live_auto_trade_enabled = CASE WHEN $2 = 'LIVE' THEN FALSE ELSE user_trading_settings.live_auto_trade_enabled END,
       live_kill_switch_enabled = CASE WHEN $2 = 'LIVE' THEN TRUE ELSE user_trading_settings.live_kill_switch_enabled END,
       updated_at = NOW()`,
    [userId, environment],
  );
  return getTradingSettings(userId);
}

export async function resetKillSwitch(userId: number, environment: TradingEnvironment) {
  const column = environment === 'DEMO' ? 'demo_kill_switch_enabled' : 'live_kill_switch_enabled';
  await query(
    `UPDATE public.user_trading_settings SET ${column} = FALSE, updated_at = NOW() WHERE user_id = $1`,
    [userId],
  );
  return getTradingSettings(userId);
}
