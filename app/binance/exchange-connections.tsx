'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { BinanceForm } from './binance-form';

type EnvironmentOption = {
  environment: 'DEMO' | 'LIVE' | 'TESTNET';
  enabled: boolean;
  supported: boolean;
  available: boolean;
  customerTradingReady: boolean;
};
type ExchangeOption = { exchange: string; name: string; environments: EnvironmentOption[] };
type CredentialStatus = {
  configured: boolean;
  environmentConfirmationRequired?: boolean;
  maskedApiKey: string | null;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
};

async function getCsrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

function GenericExchangeCredentials({
  exchange,
  name,
  environment,
  requiresPassphrase = false,
}: {
  exchange: string;
  name: string;
  environment: 'DEMO' | 'TESTNET';
  requiresPassphrase?: boolean;
}) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function loadStatus() {
      const response = await fetch(`/api/exchanges/credentials?exchange=${encodeURIComponent(exchange)}&environment=${encodeURIComponent(environment)}`, { cache: 'no-store' });
      const body = await response.json() as { data?: CredentialStatus; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `${name} ${environment} connection settings are unavailable.`);
      return body.data;
    }
    void loadStatus()
      .then((data) => { if (active) setStatus(data); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : `${name} ${environment} settings are unavailable.`);
      });
    return () => { active = false; };
  }, [exchange, environment, name]);

  async function submit(event: FormEvent, action: 'save' | 'test' | 'remove') {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const csrfToken = await getCsrfToken();
      const response = await fetch('/api/exchanges/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          action,
          exchange,
          environment,
          ...(action === 'save' ? { apiKey, apiSecret, ...(requiresPassphrase ? { passphrase } : {}) } : {}),
        }),
      });
      const body = await response.json() as { data?: CredentialStatus; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `${name} ${environment} request failed.`);
      setStatus(body.data);
      if (action === 'save') {
        setApiKey('');
        setApiSecret('');
        setPassphrase('');
      }
      setMessage(action === 'test'
        ? `${name} ${environment} account access verified. No orders were placed.`
        : action === 'remove'
          ? `${name} ${environment} credentials removed.`
          : `${name} ${environment} credentials encrypted and saved.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${name} ${environment} request failed.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
      <div>
        <p className="mono">{exchange} · {environment} / VIRTUAL FUNDS</p>
        <h3 style={{ margin: '6px 0' }}>{name} {environment} API Configuration</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {status?.configured
            ? `Configured ${status.maskedApiKey ?? ''} · ${status.lastVerifiedAt ? `Last verified ${new Date(status.lastVerifiedAt).toLocaleString()}` : 'Not tested yet'}`
            : status?.environmentConfirmationRequired
              ? `A legacy credential exists. Re-enter a dedicated ${name} ${environment} key before connecting.`
              : `No ${name} ${environment} credentials are saved yet.`}
          {' '}Use an API key with read-only and derivatives simulation permissions. Keep withdrawal permissions disabled.
        </p>
      </div>

      <label>
        {name} {environment} API Key
        <input
          autoComplete="off"
          value={apiKey}
          minLength={8}
          maxLength={256}
          placeholder="Paste exchange API key"
          onChange={(event) => setApiKey(event.target.value)}
          required
        />
      </label>

      <label>
        {name} {environment} API Secret
        <input
          type="password"
          autoComplete="new-password"
          value={apiSecret}
          minLength={8}
          maxLength={512}
          placeholder="Paste exchange API secret"
          onChange={(event) => setApiSecret(event.target.value)}
          required
        />
      </label>

      {requiresPassphrase && (
        <label>
          {name} API Passphrase
          <input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            minLength={1}
            maxLength={256}
            placeholder="Passphrase specified during API creation"
            onChange={(event) => setPassphrase(event.target.value)}
            required
          />
        </label>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}

      <div className="links">
        <button disabled={busy}>Save Encrypted Keys</button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !status?.configured}
          onClick={(event) => void submit(event, 'test')}
        >
          Test Connection
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !status?.configured}
          onClick={(event) => void submit(event, 'remove')}
        >
          Remove Keys
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        🔒 Credentials are encrypted at rest using AES-256-GCM. The API endpoint is fixed server-side.
      </p>
    </form>
  );
}

export function ExchangeConnections() {
  const [exchanges, setExchanges] = useState<ExchangeOption[]>([
    {
      exchange: 'BINANCE',
      name: 'Binance',
      environments: [
        { environment: 'DEMO', enabled: true, supported: true, available: true, customerTradingReady: true },
        { environment: 'LIVE', enabled: false, supported: true, available: false, customerTradingReady: false },
      ],
    },
    { exchange: 'BYBIT', name: 'Bybit', environments: [{ environment: 'DEMO', enabled: true, supported: true, available: true, customerTradingReady: true }] },
    { exchange: 'OKX', name: 'OKX', environments: [{ environment: 'DEMO', enabled: true, supported: true, available: true, customerTradingReady: true }] },
    { exchange: 'BITGET', name: 'Bitget', environments: [{ environment: 'DEMO', enabled: true, supported: true, available: true, customerTradingReady: true }] },
    { exchange: 'GATE', name: 'Gate.io', environments: [{ environment: 'TESTNET', enabled: true, supported: true, available: true, customerTradingReady: true }] },
  ]);
  const [selected, setSelected] = useState('BINANCE');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/exchanges', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: ExchangeOption[]; error?: string };
        const providerList = body.data;
        if (!response.ok || !providerList) throw new Error(body.error ?? 'Exchange list unavailable.');
        if (active) {
          setExchanges(providerList);
          setSelected((previous) =>
            providerList.some((item) => item.exchange === previous) ? previous : 'BINANCE',
          );
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Exchange list unavailable.');
      });
    return () => { active = false; };
  }, []);

  const chosen = exchanges.find((exchange) => exchange.exchange === selected);
  const demo = chosen?.environments.find((environment) =>
    environment.environment === 'DEMO' || environment.environment === 'TESTNET',
  );

  return (
    <section className="stack">
      {/* Security Reassurance Banner */}
      <div style={{ padding: '10px 16px', background: 'var(--surface-subtle)', borderRadius: 8, border: '1px solid var(--surface-border)', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
        <div>
          <strong style={{ color: '#10b981' }}>● MULTI-EXCHANGE GATEWAY: DEMO & TESTNET ONLY</strong>
          <span className="muted" style={{ marginLeft: 8 }}>API credentials are encrypted with AES-256-GCM. Remote testnet calls only.</span>
        </div>
        <div className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>
          🔒 LIVE TRADING: LOCKED FAIL-CLOSED (HTTP 403)
        </div>
      </div>

      {/* Exchange Selection Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        {exchanges.map((exchange) => {
          const isSelected = exchange.exchange === selected;
          const isSupported = exchange.environments.some((env) => env.supported);
          return (
            <button
              key={exchange.exchange}
              type="button"
              className="card"
              style={{
                cursor: 'pointer',
                textAlign: 'left',
                borderWidth: isSelected ? '2px' : '1px',
                borderColor: isSelected ? 'var(--accent)' : 'var(--surface-border)',
                background: isSelected ? 'var(--accent-light)' : 'var(--surface)',
                padding: '16px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                color: 'inherit',
              }}
              onClick={() => setSelected(exchange.exchange)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ color: isSelected ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {exchange.exchange}
                </span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 99,
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: 'DM Mono',
                    backgroundColor: isSupported ? '#f0fdf4' : 'var(--surface-raised)',
                    color: isSupported ? '#166534' : 'var(--text-muted)',
                  }}
                >
                  {isSupported ? 'DEMO READY' : 'SUPPORTED'}
                </span>
              </div>
              <strong style={{ fontSize: 16 }}>{exchange.name}</strong>
              <small className="muted">USDⓈ-M Perpetual Futures</small>
            </button>
          );
        })}
      </div>

      {error && <p className="error" role="status">{error}</p>}

      {/* Selected Exchange Form */}
      {selected === 'BINANCE' ? (
        <BinanceForm />
      ) : demo?.available ? (
        <GenericExchangeCredentials
          exchange={selected}
          name={chosen?.name ?? selected}
          environment={(demo.environment as 'DEMO' | 'TESTNET') ?? 'DEMO'}
          requiresPassphrase={selected === 'OKX' || selected === 'BITGET'}
        />
      ) : (
        <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 8px' }}>{chosen?.name} Configuration</h3>
          <p className="muted" style={{ margin: 0 }}>
            {demo?.supported
              ? 'This exchange adapter is available. Configure Demo or Testnet keys to begin paper execution.'
              : 'Adapter implementation is ready. The administrator manages tenant activation.'}
          </p>
        </div>
      )}
    </section>
  );
}
