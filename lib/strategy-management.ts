import { query } from './db';
import { assertExchangeFoundationReady } from './exchanges/schema';
import { isExchangeEnvironment, isExchangeId, type ExchangeEnvironment, type ExchangeId } from './exchanges/types';
import type { StrategyId } from './strategy-routing';

export type StrategyProfile = {
  strategy: StrategyId;
  exchange: ExchangeId;
  environment: ExchangeEnvironment;
  enabled: boolean;
  execution_mode: 'CONFIRM' | 'AUTOMATIC';
  risk_percentage: string;
  order_size_mode: 'FIXED' | 'RISK_BASED';
  fixed_notional_usdt: string;
  max_notional_usdt?: string;
  sl_mode?: 'BASELINE' | 'ATR' | 'MARKET_STRUCTURE' | 'ADAPTIVE_SMART';
  adaptive_protection_enabled?: boolean;
  trailing_protection_enabled?: boolean;
  leverage: number;
  max_open_positions: number | null;
  max_daily_loss_percent: string | null;
  auto_execution_enabled: boolean;
  emergency_stop_enabled: boolean;
  updated_at: string;
};

export type StrategyProfileInput = Omit<StrategyProfile, 'updated_at'>;

type StrategyRow = Omit<StrategyProfile, 'max_open_positions'> & {
  max_open_positions: number | null;
};

export class StrategySettingsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'StrategySettingsError';
  }
}

export async function assertStrategySchemaReady() {
  await assertExchangeFoundationReady();
  const result = await query<{ ready: boolean }>(
    `SELECT to_regclass('public.user_strategy_settings') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'trade_executions'
            AND column_name = 'strategy'
       )
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'trade_executions'
            AND column_name = 'trailing_client_algo_id'
       ) AS ready`,
  );
  if (!result.rows[0]?.ready) {
    throw new StrategySettingsError(
      'Strategy and protection lifecycle schema is not installed. Apply migrations 003, 202611110001, 202611110002, and 202611110003 in order.',
      503,
    );
  }
}

async function ensureUserProfiles(userId: number) {
  await query(
    `INSERT INTO public.user_strategy_settings (user_id, strategy, exchange, environment)
     VALUES ($1, 'STANDARD', 'BINANCE', 'DEMO'),
            ($1, 'HIGH_RISK_SCALPING', 'BINANCE', 'DEMO')
     ON CONFLICT (user_id, strategy) DO NOTHING`,
    [userId],
  );
}

export async function getStrategyProfiles(userId: number): Promise<StrategyProfile[]> {
  await assertStrategySchemaReady();
  await ensureUserProfiles(userId);
  const result = await query<StrategyRow>(
    `SELECT strategy, exchange, environment, enabled, execution_mode, risk_percentage::TEXT,
            order_size_mode, fixed_notional_usdt::TEXT,
            COALESCE(max_notional_usdt, 100.00)::TEXT AS max_notional_usdt,
            COALESCE(sl_mode, 'ADAPTIVE_SMART') AS sl_mode,
            COALESCE(adaptive_protection_enabled, true) AS adaptive_protection_enabled,
            COALESCE(trailing_protection_enabled, true) AS trailing_protection_enabled,
            leverage, max_open_positions,
            max_daily_loss_percent::TEXT, auto_execution_enabled, emergency_stop_enabled, updated_at
       FROM public.user_strategy_settings
      WHERE user_id = $1
      ORDER BY CASE strategy WHEN 'STANDARD' THEN 1 ELSE 2 END`,
    [userId],
  );
  return result.rows;
}

export async function saveStrategyProfile(userId: number, profile: StrategyProfileInput, confirmations: {
  confirmEnable: boolean;
  confirmAutomatic: boolean;
  confirmEmergencyStopReset: boolean;
}) {
  await assertStrategySchemaReady();
  if (!isExchangeId(profile.exchange) || !isExchangeEnvironment(profile.exchange, profile.environment)) {
    throw new StrategySettingsError('The selected exchange does not support this environment.', 422);
  }
  if (profile.enabled && (!profile.max_open_positions || !profile.max_daily_loss_percent)) {
    throw new StrategySettingsError('Set both maximum concurrent positions and maximum daily loss before enabling this strategy.', 422);
  }
  const existing = await query<{
    enabled: boolean;
    emergency_stop_enabled: boolean;
    auto_execution_enabled: boolean;
  }>(
    `SELECT enabled, emergency_stop_enabled, auto_execution_enabled FROM public.user_strategy_settings
      WHERE user_id = $1 AND strategy = $2`,
    [userId, profile.strategy],
  );
  const wasEnabled = existing.rows[0]?.enabled ?? false;
  const wasAutoEnabled = existing.rows[0]?.auto_execution_enabled ?? false;
  if (profile.enabled && !wasEnabled && !confirmations.confirmEnable) {
    throw new StrategySettingsError('Explicit confirmation is required to enable this strategy.', 422);
  }
  if (profile.emergency_stop_enabled === false && !confirmations.confirmEmergencyStopReset) {
    if (existing.rows[0]?.emergency_stop_enabled) {
      throw new StrategySettingsError('Explicit confirmation is required to reset this strategy’s emergency stop.', 422);
    }
  }
  if (profile.environment === 'LIVE' && (profile.enabled || profile.auto_execution_enabled)) {
    throw new StrategySettingsError('Live strategy execution remains strictly locked.', 403);
  }
  // Require explicit confirmation when newly enabling automatic Demo execution
  if (profile.auto_execution_enabled && !wasAutoEnabled && !confirmations.confirmAutomatic) {
    throw new StrategySettingsError('Explicit confirmation is required to enable automatic Demo execution.', 422);
  }
  const result = await query<StrategyRow>(
    `INSERT INTO public.user_strategy_settings (
       user_id, strategy, exchange, environment, enabled, execution_mode, risk_percentage,
       order_size_mode, fixed_notional_usdt, max_notional_usdt, sl_mode, adaptive_protection_enabled,
       trailing_protection_enabled, leverage, max_open_positions,
       max_daily_loss_percent, auto_execution_enabled, emergency_stop_enabled, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (user_id, strategy) DO UPDATE SET
       exchange = EXCLUDED.exchange,
       environment = EXCLUDED.environment,
       enabled = EXCLUDED.enabled,
       execution_mode = EXCLUDED.execution_mode,
       risk_percentage = EXCLUDED.risk_percentage,
       order_size_mode = EXCLUDED.order_size_mode,
       fixed_notional_usdt = EXCLUDED.fixed_notional_usdt,
       max_notional_usdt = EXCLUDED.max_notional_usdt,
       sl_mode = EXCLUDED.sl_mode,
       adaptive_protection_enabled = EXCLUDED.adaptive_protection_enabled,
       trailing_protection_enabled = EXCLUDED.trailing_protection_enabled,
       leverage = EXCLUDED.leverage,
       max_open_positions = EXCLUDED.max_open_positions,
       max_daily_loss_percent = EXCLUDED.max_daily_loss_percent,
       auto_execution_enabled = EXCLUDED.auto_execution_enabled,
       emergency_stop_enabled = EXCLUDED.emergency_stop_enabled,
       updated_at = NOW()
     RETURNING strategy, exchange, environment, enabled, execution_mode, risk_percentage::TEXT,
       order_size_mode, fixed_notional_usdt::TEXT,
       COALESCE(max_notional_usdt, 100.00)::TEXT AS max_notional_usdt,
       COALESCE(sl_mode, 'ADAPTIVE_SMART') AS sl_mode,
       COALESCE(adaptive_protection_enabled, true) AS adaptive_protection_enabled,
       COALESCE(trailing_protection_enabled, true) AS trailing_protection_enabled,
       leverage, max_open_positions,
       max_daily_loss_percent::TEXT, auto_execution_enabled, emergency_stop_enabled, updated_at`,
    [
      userId, profile.strategy, profile.exchange, profile.environment,
      profile.enabled, profile.execution_mode, profile.risk_percentage,
      profile.order_size_mode, profile.fixed_notional_usdt,
      profile.max_notional_usdt ?? '100.00',
      profile.sl_mode ?? 'ADAPTIVE_SMART',
      profile.adaptive_protection_enabled ?? true,
      profile.trailing_protection_enabled ?? true,
      profile.leverage,
      profile.max_open_positions, profile.max_daily_loss_percent,
      profile.auto_execution_enabled, profile.emergency_stop_enabled,
    ],
  );
  return result.rows[0];
}

export async function requireExecutableStrategy(
  userId: number,
  strategy: StrategyId,
  exchange: ExchangeId,
  environment: ExchangeEnvironment,
  mode: 'CONFIRM' | 'AUTOMATIC',
): Promise<StrategyProfile> {
  if (environment === 'LIVE') {
    throw new StrategySettingsError('Live strategy execution remains strictly locked.', 403);
  }
  const profiles = await getStrategyProfiles(userId);
  const profile = profiles.find((row) => row.strategy === strategy);
  if (!profile || !profile.enabled) throw new StrategySettingsError(`${strategy} is disabled. Configure and enable its independent profile first.`, 403);
  if (profile.exchange !== exchange || profile.environment !== environment) {
    throw new StrategySettingsError('The requested execution destination does not match this strategy’s selected exchange and environment.', 409);
  }
  if (profile.emergency_stop_enabled) throw new StrategySettingsError(`${strategy} emergency stop is active.`, 409);
  if (profile.max_open_positions === null || profile.max_daily_loss_percent === null) {
    throw new StrategySettingsError(`${strategy} requires configured position and daily-loss limits.`, 409);
  }
  if (mode === 'AUTOMATIC' && profile.execution_mode !== 'AUTOMATIC') {
    throw new StrategySettingsError(`Execution mode does not match the ${strategy} profile.`, 409);
  }
  if (mode === 'AUTOMATIC' && !profile.auto_execution_enabled) {
    throw new StrategySettingsError(`Automatic execution is disabled for ${strategy}.`, 409);
  }
  // Authorized Demo execution path for verified Demo environments
  if (environment === 'DEMO' || environment === 'TESTNET') {
    return profile;
  }
  throw new StrategySettingsError('Unsupported strategy execution environment.', 403);
}
