import { binanceRateLimiter, type CircuitBreakerStatus } from './binance-rate-limit';
import { query } from './db';

const CIRCUIT_BREAKER_KEY = 'binance_circuit_breaker';
let persistenceRegistered = false;

export async function ensureBinanceCooldownHydrated(now = Date.now()): Promise<CircuitBreakerStatus> {
  if (!persistenceRegistered) {
    persistenceRegistered = true;
    binanceRateLimiter.registerPersistence({
      load: async () => {
        const res = await query<{ value_json: Partial<CircuitBreakerStatus> }>(
          `SELECT value_json FROM public.app_settings WHERE key = $1`,
          [CIRCUIT_BREAKER_KEY],
        );
        return res.rows[0]?.value_json ?? null;
      },
      save: async (status) => {
        await query(
          `INSERT INTO public.app_settings (key, value_json, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
          [CIRCUIT_BREAKER_KEY, JSON.stringify(status)],
        );
      },
    });
  }
  return binanceRateLimiter.hydrate(now);
}
