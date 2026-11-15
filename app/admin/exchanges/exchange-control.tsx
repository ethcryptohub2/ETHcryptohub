'use client';

import { useEffect, useState } from 'react';

type Provider = {
  exchange: string;
  name: string;
  customer_enabled: boolean;
  adapter_version: string;
  demo_verified_at: string | null;
  testnet_verified_at: string | null;
  live_approved_at: string | null;
  last_verified_at: string | null;
  hasIntegrationError: boolean;
  environments: Array<{
    environment: 'DEMO' | 'TESTNET' | 'LIVE';
    enabled: boolean;
    supported: boolean;
    customerTradingReady: boolean;
    configuredAccounts: number;
    lastConnectionTest: { status: string; checkedAt: string } | null;
  }>;
  capabilities: Record<string, boolean>;
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

async function fetchProviders() {
  const response = await fetch('/api/admin/exchanges', { cache: 'no-store' });
  const body = await response.json() as { data?: Provider[]; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error ?? 'Exchange status is unavailable.');
  return body.data;
}

export function ExchangeControl() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetchProviders()
      .then((data) => {
        if (active) {
          setProviders(data);
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Exchange status is unavailable.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function setEnvironment(exchange: string, environment: Provider['environments'][number]['environment'], enabled: boolean) {
    const identity = `${exchange}:${environment}`;
    setBusy(identity);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/admin/exchanges', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ type: 'environment', exchange, environment, enabled }),
      });
      const body = await response.json() as { data?: Provider[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Provider setting could not be updated.');
      setProviders(body.data);
      setMessage(`${exchange} ${environment} setting updated.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider setting could not be updated.');
    } finally {
      setBusy('');
    }
  }

  async function setCustomerAccess(exchange: string, enabled: boolean) {
    setBusy(`${exchange}:customer`);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/admin/exchanges', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ type: 'customer', exchange, enabled }),
      });
      const body = await response.json() as { data?: Provider[]; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Customer access could not be updated.');
      setProviders(body.data);
      setMessage(`${exchange} customer access ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Customer access could not be updated.');
    } finally {
      setBusy('');
    }
  }

  if (loading) return <section className="card"><p className="muted">Loading exchange readiness…</p></section>;

  return <section className="stack">
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}
    <p className="muted">A saved key or successful connection check alone does not enable order execution. Unverified providers remain unavailable; Live approval is managed separately.</p>
    {providers.map((provider) => <article className="card stack" key={provider.exchange}>
      <div>
        <p className="mono">{provider.exchange} · ADAPTER {provider.adapter_version}</p>
        <h2>{provider.name}</h2>
        <p className="muted">
          Customer access: {provider.customer_enabled ? 'enabled' : 'disabled'} · configured credential records: {provider.environments.reduce((sum, item) => sum + item.configuredAccounts, 0)}
          {provider.last_verified_at ? ` · last verified ${new Date(provider.last_verified_at).toLocaleString()}` : ' · never verified'}
          {provider.hasIntegrationError ? ' · a provider error is recorded (details withheld)' : ''}
        </p>
        <button
          type="button"
          className="button-secondary"
          disabled={Boolean(busy) || (!provider.customer_enabled && !provider.environments.some((item) => item.customerTradingReady))}
          onClick={() => void setCustomerAccess(provider.exchange, !provider.customer_enabled)}
        >
          {busy === `${provider.exchange}:customer` ? 'Updating…' : provider.customer_enabled ? 'Disable customer access' : 'Enable customer access'}
        </button>
      </div>
      <div className="notification-control-grid">
        {provider.environments.map((item) => {
          const verification = item.environment === 'DEMO'
            ? provider.demo_verified_at
            : item.environment === 'TESTNET'
              ? provider.testnet_verified_at
              : provider.live_approved_at;
          const canEnable = Boolean(verification && item.supported && provider.customer_enabled);
          return <div className="card stack" key={item.environment}>
            <p className="mono">{item.environment} · {item.environment === 'LIVE' ? 'REAL FUNDS' : 'SIMULATED FUNDS'}</p>
            <p className="muted">
              {item.supported ? 'Connection implementation available' : 'NOT IMPLEMENTED — DISABLED'}
              {' · '}
              {item.customerTradingReady ? 'trading adapter ready' : 'order execution disabled'}
              {' · '}
              {verification ? 'admin verification recorded' : 'not verified'}
            </p>
            <p className="muted">
              Last connection test: {item.lastConnectionTest
                ? `${item.lastConnectionTest.status} · ${new Date(item.lastConnectionTest.checkedAt).toLocaleString()}`
                : 'not run'}
            </p>
            <p className="muted">
              Capability flags: {Object.entries(provider.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'none'}
            </p>
            <button
              type="button"
              className="button-secondary"
              disabled={Boolean(busy) || (!item.enabled && !canEnable) || item.environment === 'LIVE'}
              onClick={() => void setEnvironment(provider.exchange, item.environment, !item.enabled)}
              title={item.environment === 'LIVE' ? 'Live authorization requires a separate reviewed process.' : undefined}
            >
              {busy === `${provider.exchange}:${item.environment}` ? 'Updating…' : item.enabled ? `Disable ${item.environment}` : `Enable ${item.environment}`}
            </button>
          </div>;
        })}
      </div>
    </article>)}
  </section>;
}
