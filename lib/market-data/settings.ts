import { decryptCredential, encryptCredential } from '../binance-credentials';
import { query } from '../db';
import type { MarketDataSettingsView } from './provider-types';

const SETTINGS_KEY = 'market_data_failover_settings';

interface StoredMarketDataSettings {
  autoFailoverEnabled: boolean;
  binanceEnabled: boolean;
  coinapiEnabled: boolean;
  coinapiKeyCiphertext: string | null;
  alternativeEnabled: boolean;
  historicalCacheEnabled: boolean;
  freeOnlyPolicy: boolean;
  fullScanIntervalSeconds: number;
  updatedAt: string | null;
}

export function defaultStoredMarketDataSettings(): StoredMarketDataSettings {
  return {
    autoFailoverEnabled: true,
    binanceEnabled: true,
    coinapiEnabled: true,
    coinapiKeyCiphertext: null,
    alternativeEnabled: false, // CryptoDataDownload is historical-only; disabled as live provider by default
    historicalCacheEnabled: true,
    freeOnlyPolicy: true,
    fullScanIntervalSeconds: 300,
    updatedAt: null,
  };
}

function maskKey(raw: string | null): string | null {
  if (!raw || raw.length < 4) return null;
  return `••••${raw.slice(-4)}`;
}

export async function getStoredMarketDataSettings(): Promise<StoredMarketDataSettings> {
  const defaults = defaultStoredMarketDataSettings();
  try {
    const res = await query<{ value_json: Partial<StoredMarketDataSettings> }>(
      `SELECT value_json FROM public.app_settings WHERE key = $1`,
      [SETTINGS_KEY],
    );
    const row = res.rows[0]?.value_json;
    if (!row) return defaults;
    return {
      autoFailoverEnabled: typeof row.autoFailoverEnabled === 'boolean' ? row.autoFailoverEnabled : defaults.autoFailoverEnabled,
      binanceEnabled: typeof row.binanceEnabled === 'boolean' ? row.binanceEnabled : defaults.binanceEnabled,
      coinapiEnabled: typeof row.coinapiEnabled === 'boolean' ? row.coinapiEnabled : defaults.coinapiEnabled,
      coinapiKeyCiphertext: typeof row.coinapiKeyCiphertext === 'string' ? row.coinapiKeyCiphertext : null,
      alternativeEnabled: typeof row.alternativeEnabled === 'boolean' ? row.alternativeEnabled : defaults.alternativeEnabled,
      historicalCacheEnabled: typeof row.historicalCacheEnabled === 'boolean' ? row.historicalCacheEnabled : defaults.historicalCacheEnabled,
      freeOnlyPolicy: typeof row.freeOnlyPolicy === 'boolean' ? row.freeOnlyPolicy : defaults.freeOnlyPolicy,
      fullScanIntervalSeconds:
        typeof row.fullScanIntervalSeconds === 'number' && row.fullScanIntervalSeconds >= 60 && row.fullScanIntervalSeconds <= 3600
          ? row.fullScanIntervalSeconds
          : defaults.fullScanIntervalSeconds,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    };
  } catch {
    return defaults;
  }
}

export function resolveCoinApiKey(stored: StoredMarketDataSettings): string | null {
  if (stored.coinapiKeyCiphertext) {
    try {
      const decrypted = decryptCredential(stored.coinapiKeyCiphertext).trim();
      if (decrypted.length > 0) return decrypted;
    } catch {
      // Fall through to env
    }
  }
  const envKey = process.env.COINAPI_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : null;
}

export async function getMarketDataSettingsView(): Promise<MarketDataSettingsView> {
  const stored = await getStoredMarketDataSettings();
  const resolvedKey = resolveCoinApiKey(stored);
  return {
    autoFailoverEnabled: stored.autoFailoverEnabled,
    binanceEnabled: stored.binanceEnabled,
    coinapiEnabled: stored.coinapiEnabled,
    coinapiConfigured: Boolean(resolvedKey),
    coinapiKeyMasked: maskKey(resolvedKey),
    alternativeEnabled: stored.alternativeEnabled,
    historicalCacheEnabled: stored.historicalCacheEnabled,
    freeOnlyPolicy: stored.freeOnlyPolicy,
    fullScanIntervalSeconds: stored.fullScanIntervalSeconds,
    updatedAt: stored.updatedAt,
  };
}

export async function updateMarketDataSettings(patch: {
  autoFailoverEnabled?: boolean;
  binanceEnabled?: boolean;
  coinapiEnabled?: boolean;
  coinapiApiKey?: string | null; // null clears stored key, undefined keeps existing
  alternativeEnabled?: boolean;
  historicalCacheEnabled?: boolean;
  freeOnlyPolicy?: boolean;
  fullScanIntervalSeconds?: number;
}): Promise<MarketDataSettingsView> {
  const current = await getStoredMarketDataSettings();
  let nextCiphertext = current.coinapiKeyCiphertext;
  if (patch.coinapiApiKey === null) {
    nextCiphertext = null;
  } else if (typeof patch.coinapiApiKey === 'string') {
    const trimmed = patch.coinapiApiKey.trim();
    if (trimmed.length < 8 || /[\r\n]/.test(trimmed)) {
      throw new Error('Enter a valid CoinAPI key (at least 8 characters, single line).');
    }
    nextCiphertext = encryptCredential(trimmed);
  }

  const next: StoredMarketDataSettings = {
    autoFailoverEnabled: patch.autoFailoverEnabled ?? current.autoFailoverEnabled,
    binanceEnabled: patch.binanceEnabled ?? current.binanceEnabled,
    coinapiEnabled: patch.coinapiEnabled ?? current.coinapiEnabled,
    coinapiKeyCiphertext: nextCiphertext,
    alternativeEnabled: patch.alternativeEnabled ?? current.alternativeEnabled,
    historicalCacheEnabled: patch.historicalCacheEnabled ?? current.historicalCacheEnabled,
    freeOnlyPolicy: patch.freeOnlyPolicy ?? current.freeOnlyPolicy,
    fullScanIntervalSeconds: patch.fullScanIntervalSeconds ?? current.fullScanIntervalSeconds,
    updatedAt: new Date().toISOString(),
  };

  await query(
    `INSERT INTO public.app_settings (key, value_json, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [SETTINGS_KEY, JSON.stringify(next)],
  );

  return getMarketDataSettingsView();
}
