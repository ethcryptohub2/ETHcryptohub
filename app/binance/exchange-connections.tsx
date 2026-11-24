'use client';

import Link from 'next/link';
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
  const body = (await response.json()) as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

const exchangeGuideUrls: Record<string, { portal: string; url: string; market: string }> = {
  BYBIT: {
    portal: 'Bybit Testnet Portal',
    url: 'https://testnet.bybit.com',
    market: 'USDT Perpetual Futures Sandbox',
  },
  OKX: {
    portal: 'OKX Demo Trading Portal',
    url: 'https://www.okx.com/demo-trading',
    market: 'USDT Swap / Derivatives Sandbox',
  },
  BITGET: {
    portal: 'Bitget Demo Trading Portal',
    url: 'https://www.bitget.com',
    market: 'USDT Futures Demo Sandbox',
  },
  GATE: {
    portal: 'Gate.io Testnet Portal',
    url: 'https://www.gate.io/testnet',
    market: 'USDT Futures Testnet Sandbox',
  },
};

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
      const response = await fetch(
        `/api/exchanges/credentials?exchange=${encodeURIComponent(exchange)}&environment=${encodeURIComponent(environment)}`,
        { cache: 'no-store' },
      );
      const body = (await response.json()) as { data?: CredentialStatus; error?: string };
      if (!response.ok || !body.data) {
        throw new Error(body.error ?? `${name} ${environment} connection settings are unavailable.`);
      }
      return body.data;
    }
    void loadStatus()
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : `${name} ${environment} settings are unavailable.`);
      });
    return () => {
      active = false;
    };
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
      const body = (await response.json()) as { data?: CredentialStatus; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `${name} ${environment} request failed.`);
      setStatus(body.data);
      if (action === 'save') {
        setApiKey('');
        setApiSecret('');
        setPassphrase('');
      }
      setMessage(
        action === 'test'
          ? `✓ ${name} ${environment} account access verified. Remote sandbox connection operational. No orders were placed.`
          : action === 'remove'
            ? `${name} ${environment} credentials removed.`
            : `${name} ${environment} credentials encrypted and saved with AES-256-GCM.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${name} ${environment} request failed.`);
    } finally {
      setBusy(false);
    }
  }

  const guide = exchangeGuideUrls[exchange];

  return (
    <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
      {/* Prominent Demo Mode Banner */}
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--surface-subtle)',
          borderRadius: 8,
          border: '1px solid var(--accent)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
            {exchange} · {environment} / VIRTUAL FUNDS
          </span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 99,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'DM Mono',
              backgroundColor: status?.configured ? '#f0fdf4' : 'var(--surface-raised)',
              color: status?.configured ? '#166534' : 'var(--text-muted)',
            }}
          >
            {status?.configured
              ? status.lastVerifiedAt
                ? '✓ CONNECTED & VERIFIED'
                : '● CONFIGURED'
              : '○ NOT CONFIGURED'}
          </span>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>{name} {environment} API Configuration</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {status?.configured
            ? `Configured ${status.maskedApiKey ?? ''} · ${status.lastVerifiedAt ? `Last verified ${new Date(status.lastVerifiedAt).toLocaleString()}` : 'Not tested yet'}`
            : status?.environmentConfirmationRequired
              ? `A legacy credential exists. Re-enter a dedicated ${name} ${environment} key before connecting.`
              : `No ${name} ${environment} credentials are saved yet.`}
          {' '}Virtual funds only. Keep withdrawal permissions disabled.
        </p>
        {guide && (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            💡 <strong>How to get keys:</strong> Visit{' '}
            <a href={guide.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
              {guide.portal}
            </a>{' '}
            ({guide.market}) → API Management → Create Demo/Testnet API Key.
          </p>
        )}
      </div>

      <label>
        {name} {environment} API Key
        <input
          autoComplete="off"
          value={apiKey}
          minLength={8}
          maxLength={256}
          placeholder={`Paste ${name} ${environment} API key`}
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
          placeholder={`Paste ${name} ${environment} API secret`}
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
            placeholder={`Passphrase specified when creating ${name} API key`}
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
        🔒 Credentials are encrypted at rest using AES-256-GCM. Remote sandbox endpoint is fixed server-side.
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
  const [activeMode, setActiveMode] = useState<'paper' | 'demo' | 'live'>('demo');

  useEffect(() => {
    let active = true;
    void fetch('/api/exchanges', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as { data?: ExchangeOption[]; error?: string };
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
    return () => {
      active = false;
    };
  }, []);

  const chosen = exchanges.find((exchange) => exchange.exchange === selected);
  const demo = chosen?.environments.find(
    (environment) => environment.environment === 'DEMO' || environment.environment === 'TESTNET',
  );

  return (
    <section className="stack">
      {/* 3-Mode Execution Environment Selector */}
      <div
        className="card"
        style={{
          padding: '16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        <Link
          href="/positions"
          style={{
            padding: '14px 16px',
            borderRadius: 8,
            border: activeMode === 'paper' ? '2px solid var(--accent)' : '1px solid var(--surface-border)',
            background: activeMode === 'paper' ? 'var(--accent-light)' : 'var(--surface-raised)',
            textDecoration: 'none',
            color: 'inherit',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
          onClick={() => setActiveMode('paper')}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14 }}>1. Internal Paper Simulation</strong>
            <span style={{ fontSize: 10, fontFamily: 'DM Mono', padding: '2px 6px', borderRadius: 99, background: '#f0fdf4', color: '#166534', fontWeight: 600 }}>
              ACTIVE
            </span>
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            Built-in algorithmic simulator. 100% virtual funds, zero API keys required. View active paper positions →
          </small>
        </Link>

        <div
          role="button"
          tabIndex={0}
          style={{
            cursor: 'pointer',
            padding: '14px 16px',
            borderRadius: 8,
            border: activeMode === 'demo' ? '2px solid var(--accent)' : '1px solid var(--surface-border)',
            background: activeMode === 'demo' ? 'var(--accent-light)' : 'var(--surface-raised)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
          onClick={() => setActiveMode('demo')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveMode('demo'); }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14, color: 'var(--accent)' }}>2. Authenticated Exchange Demo / Testnet</strong>
            <span style={{ fontSize: 10, fontFamily: 'DM Mono', padding: '2px 6px', borderRadius: 99, background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>
              CURRENT TAB
            </span>
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            Connect 5 exchange demo/testnet sandboxes with dedicated virtual keys. Real capital is never at risk.
          </small>
        </div>

        <div
          role="button"
          tabIndex={0}
          style={{
            cursor: 'pointer',
            padding: '14px 16px',
            borderRadius: 8,
            border: activeMode === 'live' ? '2px solid #ef4444' : '1px solid var(--surface-border)',
            background: activeMode === 'live' ? 'rgba(239, 68, 68, 0.08)' : 'var(--surface-raised)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
          onClick={() => setActiveMode('live')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveMode('live'); }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 14, color: '#ef4444' }}>3. Real-Money Live Trading</strong>
            <span style={{ fontSize: 10, fontFamily: 'DM Mono', padding: '2px 6px', borderRadius: 99, background: '#fee2e2', color: '#991b1b', fontWeight: 600 }}>
              LOCKED 403
            </span>
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            🔒 Visibly locked fail-closed by platform policy. Real capital execution is disabled.
          </small>
        </div>
      </div>

      {/* Security Reassurance Banner */}
      <div
        style={{
          padding: '10px 16px',
          background: 'var(--surface-subtle)',
          borderRadius: 8,
          border: '1px solid var(--surface-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          fontSize: 12,
        }}
      >
        <div>
          <strong style={{ color: '#10b981' }}>● MULTI-EXCHANGE GATEWAY: DEMO &amp; TESTNET ONLY</strong>
          <span className="muted" style={{ marginLeft: 8 }}>
            API credentials are encrypted with AES-256-GCM. Remote testnet calls only.
          </span>
        </div>
        <div className="mono" style={{ color: '#ef4444', fontWeight: 600 }}>
          🔒 LIVE TRADING: LOCKED FAIL-CLOSED (HTTP 403)
        </div>
      </div>

      {/* When user clicks Live Trading mode card */}
      {activeMode === 'live' && (
        <div
          className="card"
          style={{
            padding: '24px',
            border: '1px solid #ef4444',
            background: 'rgba(239, 68, 68, 0.05)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ fontSize: 32 }}>🔒</div>
          <h3 style={{ margin: 0, color: '#ef4444' }}>
            Live Real-Money Trading is Locked Fail-Closed (HTTP 403)
          </h3>
          <p className="muted" style={{ maxWidth: 560, margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Live execution is disabled by platform policy. Antigravity and operator safety rules strictly prohibit
            real-money order routing. Real funds are never at risk. SmartExit operates exclusively in high-fidelity Demo
            and Paper simulation modes.
          </p>
          <button
            type="button"
            className="button"
            style={{ marginTop: 8 }}
            onClick={() => setActiveMode('demo')}
          >
            ← Return to Authenticated Exchange Demo / Testnet
          </button>
        </div>
      )}

      {/* Exchange Selection Grid (Visible when Demo mode is active) */}
      {activeMode !== 'live' && (
        <>
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
                      {exchange.exchange === 'GATE' ? 'TESTNET READY' : 'DEMO READY'}
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
        </>
      )}
    </section>
  );
}
