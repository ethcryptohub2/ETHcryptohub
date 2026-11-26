'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MarketDataSettingsView, ProviderHealthSnapshot } from '../../lib/market-data/provider-types';

async function fetchCsrfToken() {
  const res = await fetch('/api/csrf', { cache: 'no-store' });
  const body = (await res.json()) as { data?: { csrfToken: string } };
  if (!res.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function AdminMarketData() {
  const [settings, setSettings] = useState<MarketDataSettingsView | null>(null);
  const [providers, setProviders] = useState<ProviderHealthSnapshot[]>([]);
  const [coinapiInput, setCoinapiInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/market-data', { cache: 'no-store' });
      const json = (await res.json()) as { data?: { settings: MarketDataSettingsView; providers: ProviderHealthSnapshot[] }; error?: string };
      if (!res.ok || !json.data) throw new Error(json.error ?? 'Failed to load market data settings.');
      setSettings(json.data.settings);
      setProviders(json.data.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load market data settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/admin/market-data', { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json()) as { data?: { settings: MarketDataSettingsView; providers: ProviderHealthSnapshot[] }; error?: string };
        if (!res.ok || !json.data) throw new Error(json.error ?? 'Failed to load market data settings.');
        return json.data;
      })
      .then((data) => {
        if (!active) return;
        setSettings(data.settings);
        setProviders(data.providers);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load market data settings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const savePatch = async (patch: Record<string, unknown>, successMsg: string) => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const csrf = await fetchCsrfToken();
      const res = await fetch('/api/admin/market-data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as { data?: { settings: MarketDataSettingsView; providers: ProviderHealthSnapshot[] }; error?: string };
      if (!res.ok || !json.data) throw new Error(json.error ?? 'Failed to save market data settings.');
      setSettings(json.data.settings);
      setProviders(json.data.providers);
      setMessage(successMsg);
      if ('coinapiApiKey' in patch) setCoinapiInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="admin-market-data" className="card stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Market Data Failover & Providers (Admin Only)</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            Automatic multi-provider Binance USD-M Futures market data failover, encrypted credentials, and free-only quota controls.
          </p>
        </div>
        <button type="button" className="button-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : '⟳ Refresh Health'}
        </button>
      </div>

      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
      {message && <p style={{ margin: 0, color: '#10b981', fontWeight: 600, fontSize: 13 }}>✓ {message}</p>}

      {settings && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>Automatic API Failover</span>
              <input
                type="checkbox"
                checked={settings.autoFailoverEnabled}
                disabled={saving}
                onChange={(e) => void savePatch({ autoFailoverEnabled: e.target.checked }, 'Failover setting updated.')}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>Binance Official (Primary)</span>
              <input
                type="checkbox"
                checked={settings.binanceEnabled}
                disabled={saving}
                onChange={(e) => void savePatch({ binanceEnabled: e.target.checked }, 'Binance provider toggle updated.')}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>CoinAPI BINANCEFTS (Backup)</span>
              <input
                type="checkbox"
                checked={settings.coinapiEnabled}
                disabled={saving}
                onChange={(e) => void savePatch({ coinapiEnabled: e.target.checked }, 'CoinAPI provider toggle updated.')}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>Alternative Live Provider</span>
              <input
                type="checkbox"
                checked={settings.alternativeEnabled}
                disabled={saving}
                onChange={(e) => void savePatch({ alternativeEnabled: e.target.checked }, 'Alternative provider toggle updated.')}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>Binance Vision Historical Cache</span>
              <input
                type="checkbox"
                checked={settings.historicalCacheEnabled}
                disabled={saving}
                onChange={(e) => void savePatch({ historicalCacheEnabled: e.target.checked }, 'Historical cache toggle updated.')}
              />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8 }}>
              <span>Free-Only Cost Policy</span>
              <input
                type="checkbox"
                checked={settings.freeOnlyPolicy}
                disabled={saving}
                onChange={(e) => void savePatch({ freeOnlyPolicy: e.target.checked }, 'Cost policy updated.')}
              />
            </label>
          </div>

          <div style={{ padding: '12px 14px', border: '1px solid var(--surface-border)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <strong>CoinAPI Encrypted Credential (BINANCEFTS)</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  Status: {settings.coinapiConfigured ? `Configured (${settings.coinapiKeyMasked})` : 'Not configured — enter free-tier API key or set COINAPI_API_KEY env'}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Full Scan Interval: {settings.fullScanIntervalSeconds}s
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="password"
                value={coinapiInput}
                onChange={(e) => setCoinapiInput(e.target.value)}
                placeholder="Enter CoinAPI API key (encrypted at rest)"
                style={{ flex: '1 1 260px' }}
              />
              <button
                type="button"
                className="button"
                disabled={saving || coinapiInput.trim().length < 8}
                onClick={() => void savePatch({ coinapiApiKey: coinapiInput.trim() }, 'CoinAPI key encrypted and saved.')}
              >
                Save Key
              </button>
              {settings.coinapiConfigured && (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={saving}
                  onClick={() => void savePatch({ coinapiApiKey: null }, 'Stored CoinAPI key removed.')}
                >
                  Clear Key
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {providers.map((p) => (
          <div key={p.id} style={{ padding: '10px 12px', border: '1px solid var(--surface-border)', borderRadius: 8, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong>{p.label}</strong>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: p.circuitState === 'CLOSED' ? 'rgba(16,185,129,0.15)' : p.circuitState === 'OPEN' ? 'rgba(245,158,11,0.18)' : 'var(--surface-raised)',
                  color: p.circuitState === 'CLOSED' ? '#10b981' : p.circuitState === 'OPEN' ? '#d97706' : 'var(--text-secondary)',
                }}
              >
                {p.circuitState}
              </span>
            </div>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {p.quota.dailyLimit !== null ? `Quota: ${p.quota.dailyUsed}/${p.quota.dailyLimit}/day` : p.quota.minuteWeightLimit ? `Weight: ${p.quota.minuteWeightUsed}/${p.quota.minuteWeightLimit}/m` : 'Archive / Unlimited'}
              {p.capabilities.historicalOnly ? ' · Historical-only' : ''}
            </div>
            {p.cooldownUntil && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }} suppressHydrationWarning>
                Cooldown until: {new Date(p.cooldownUntil).toLocaleString('en-US')}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
