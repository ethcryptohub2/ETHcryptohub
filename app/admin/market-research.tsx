'use client';

import { useEffect, useState } from 'react';

type Provider = 'glassnode' | 'cryptopanic' | 'coinglass';
type ProviderStatus = { configured: boolean; updatedAt: string | null };
type Settings = Record<Provider, ProviderStatus>;

const providers: Array<{ id: Provider; label: string; description: string }> = [
  { id: 'glassnode', label: 'Glassnode', description: 'On-chain exchange netflow context. This is not verified smart-wallet attribution.' },
  { id: 'cryptopanic', label: 'CryptoPanic', description: 'Recent crypto headlines and community vote counts.' },
  { id: 'coinglass', label: 'CoinGlass', description: 'Liquidation heatmap levels. The endpoint requires a plan that includes heatmaps.' },
];

export function AdminMarketResearch() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<Provider, string>>({
    glassnode: '',
    cryptopanic: '',
    coinglass: '',
  });
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const response = await fetch('/api/admin/market-research', { cache: 'no-store' });
    const body = await response.json() as { data?: Settings; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load market research settings.');
    setSettings(body.data);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Market research settings failed to load.'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function update(provider: Provider, action: 'save' | 'remove') {
    setBusy(provider);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const token = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('Secure admin session unavailable.');
      const response = await fetch('/api/admin/market-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ provider, action, apiKey: action === 'save' ? apiKeys[provider] : undefined }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Provider settings could not be saved.');
      setApiKeys((current) => ({ ...current, [provider]: '' }));
      await load();
      setNotice(`${providers.find((item) => item.id === provider)?.label} settings updated.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider settings could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  return <section className="stack">
    <div className="card stack">
      <h2>Market research providers</h2>
      <p className="muted">Keys are encrypted at rest and never sent back to the browser. Configure BINANCE_CREDENTIALS_KEY in the deployment environment before saving provider keys. Applying the database migration is also required.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="success">{notice}</p>}
      {!settings && !error && <p className="muted">Loading provider settings…</p>}
      {providers.map((provider) => {
        const status = settings?.[provider.id];
        return <article className="card stack" key={provider.id}>
          <div className="links">
            <h3>{provider.label}</h3>
            <span className="mono">{status?.configured ? 'CONFIGURED' : 'NOT CONFIGURED'}</span>
          </div>
          <p className="muted">{provider.description}</p>
          <label>{status?.configured ? 'Replace API key' : 'API key'}
            <input
              type="password"
              value={apiKeys[provider.id]}
              onChange={(event) => setApiKeys((current) => ({ ...current, [provider.id]: event.target.value }))}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={512}
              placeholder={status?.configured ? 'Leave blank to keep current key' : 'Enter provider API key'}
            />
          </label>
          {status?.updatedAt && <p className="muted">Updated {new Date(status.updatedAt).toLocaleString()}</p>}
          <div className="links">
            <button disabled={busy !== null || !apiKeys[provider.id].trim()} onClick={() => void update(provider.id, 'save')}>
              {busy === provider.id ? 'Saving…' : 'Save key'}
            </button>
            {status?.configured && <button disabled={busy !== null} onClick={() => void update(provider.id, 'remove')}>Remove key</button>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}
