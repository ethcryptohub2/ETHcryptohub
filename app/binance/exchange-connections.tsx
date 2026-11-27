'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { BinanceForm } from './binance-form';

type EnvironmentOption = {
  environment: 'DEMO' | 'LIVE' | 'TESTNET';
  enabled: boolean;
  supported: boolean;
  available: boolean;
  customerTradingReady: boolean;
  configured?: boolean;
  configuredAccounts?: number;
  lastVerifiedAt?: string | null;
  userAutoTradeEnabled?: boolean;
};
type ExchangeOption = { exchange: string; name: string; environments: EnvironmentOption[] };
type CredentialStatus = {
  configured: boolean;
  environmentConfirmationRequired?: boolean;
  maskedApiKey: string | null;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
};

function getExchangeBadge(status?: { configured?: boolean; lastVerifiedAt?: string | null }) {
  if (status?.configured && status.lastVerifiedAt) {
    return { label: 'ACCOUNT READ VERIFIED', color: '#15803d', bg: '#f0fdf4' };
  }
  const label = !status ? 'STATUS UNAVAILABLE' :
    status.configured ? 'KEYS SAVED' : 'NO CONFIRMED KEYS';
  return { label, color: 'var(--text-muted)', bg: 'var(--surface-raised)' };
}

const sandboxProviders = [
  { id: 'BINANCE', name: 'Binance', environment: 'DEMO' },
  { id: 'BYBIT', name: 'Bybit', environment: 'DEMO' },
  { id: 'OKX', name: 'OKX', environment: 'DEMO' },
  { id: 'BITGET', name: 'Bitget', environment: 'DEMO' },
  { id: 'GATE', name: 'Gate.io', environment: 'TESTNET' },
] as const;

function sandboxEnvironment(exchange: ExchangeOption) {
  return exchange.environments.find((environment) => environment.environment === (exchange.exchange === 'GATE' ? 'TESTNET' : 'DEMO'));
}

async function getCsrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = (await response.json()) as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

const exchangeGuideUrls: Record<string, { portal: string; url: string; market: string }> = {
  BYBIT: {
    portal: 'Bybit Demo Trading Portal',
    url: 'https://api-demo.bybit.com',
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

  const badgeInfo = getExchangeBadge(status ?? undefined);

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
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('smartexit-exchange-credential-synced'));
      }
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
              backgroundColor: badgeInfo.bg,
              color: badgeInfo.color,
            }}
          >
            {badgeInfo.label}
          </span>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>{name} {environment} API Configuration</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {!status ? 'Credential status is unavailable until the account check completes.' : status.configured
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
          type="password"
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
  const [exchanges, setExchanges] = useState<ExchangeOption[]>([]);
  const [selected, setSelected] = useState<(typeof sandboxProviders)[number]['id']>('BINANCE');
  const [error, setError] = useState('');
  const [activeMode, setActiveMode] = useState<'demo' | 'live'>('demo');
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  async function toggleExchangeSwitch(exchange: string, environment: 'DEMO' | 'TESTNET', currentValue: boolean | undefined) {
    if (pendingSwitch || currentValue === undefined) return;
    setPendingSwitch(exchange);
    try {
      const csrfToken = await getCsrfToken();
      const response = await fetch('/api/exchanges', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ exchange, environment, enabled: !currentValue }),
      });
      const body = (await response.json()) as { data?: { autoTradeEnabled?: boolean }; error?: string };
      const saved = body.data?.autoTradeEnabled;
      if (!response.ok || typeof saved !== 'boolean') {
        throw new Error(body.error ?? 'Could not save the automatic execution preference.');
      }
      setExchanges((providers) => providers.map((provider) => provider.exchange !== exchange ? provider : {
        ...provider,
        environments: provider.environments.map((option) => option.environment !== environment ? option : {
          ...option,
          userAutoTradeEnabled: saved,
        }),
      }));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the automatic execution preference.');
    } finally {
      setPendingSwitch(null);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function readProviders() {
      try {
        const response = await fetch('/api/exchanges', { cache: 'no-store', signal: controller.signal });
        const body = (await response.json()) as { data?: ExchangeOption[]; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Exchange list unavailable.');
        if (!controller.signal.aborted) {
          setExchanges(body.data);
          setError('');
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setExchanges([]);
          setError(reason instanceof Error ? reason.message : 'Exchange list unavailable.');
        }
      }
    }
    const handleCredentialSync = () => { void readProviders(); };
    handleCredentialSync();
    window.addEventListener('smartexit-exchange-credential-synced', handleCredentialSync);
    return () => {
      controller.abort();
      window.removeEventListener('smartexit-exchange-credential-synced', handleCredentialSync);
    };
  }, []);

  const environments = new Map(exchanges.map((exchange) => [exchange.exchange, sandboxEnvironment(exchange)] as const));
  const chosen = sandboxProviders.find((exchange) => exchange.id === selected)!;

  return (
    <section className="stack">
      {/* 2-Mode Execution Environment Selector */}
      <div
        className="card"
        style={{
          padding: '16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 12,
        }}
      >
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
            <strong style={{ fontSize: 14, color: 'var(--accent)' }}>1. Authenticated Exchange Demo / Testnet</strong>
            <span style={{ fontSize: 10, fontFamily: 'DM Mono', padding: '2px 6px', borderRadius: 99, background: 'var(--accent)', color: '#fff', fontWeight: 600 }}>
              ACTIVE MODE
            </span>
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            Manage sandbox credentials and verify account access on supported providers.
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
            <strong style={{ fontSize: 14, color: '#ef4444' }}>2. Real-Money Live Trading</strong>
            <span style={{ fontSize: 10, fontFamily: 'DM Mono', padding: '2px 6px', borderRadius: 99, background: '#fee2e2', color: '#991b1b', fontWeight: 600 }}>
              LOCKED 403
            </span>
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            🔒 Visibly locked fail-closed by platform policy. Real capital execution is disabled.
          </small>
        </div>
      </div>

      {/* Multi-Exchange Parallel Execution Control Center */}
      <div
        className="card"
        style={{
          padding: '16px 20px',
          background: 'var(--surface-raised)',
          border: '1px solid var(--surface-border)',
          borderRadius: 8,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div>
            <strong style={{ fontSize: 14, display: 'block' }}>Automatic Execution Preferences</strong>
            <small className="muted" style={{ fontSize: 12 }}>
              These saved preferences apply only when the provider and automatic execution are enabled by the platform.
            </small>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {sandboxProviders.map((item) => {
            const preference = environments.get(item.id)?.userAutoTradeEnabled;
            const isEnabled = preference === true;
            return (
              <div
                key={item.id}
                style={{
                  padding: '10px 14px',
                  borderRadius: 6,
                  border: isEnabled ? '1px solid var(--accent)' : '1px solid var(--surface-border)',
                  background: isEnabled ? 'var(--accent-light)' : 'var(--surface)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div>
                  <strong style={{ fontSize: 12, display: 'block' }}>{item.id}</strong>
                  <small className="muted" style={{ fontSize: 10 }}>{item.environment}</small>
                </div>
                <button
                  type="button"
                  aria-label={`${item.name} automatic execution preference`}
                  aria-pressed={preference}
                  disabled={pendingSwitch !== null || preference === undefined}
                  onClick={() => void toggleExchangeSwitch(item.id, item.environment, preference)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: 'DM Mono',
                    borderRadius: 4,
                    border: 'none',
                    cursor: 'pointer',
                    background: isEnabled ? '#10b981' : 'var(--surface-raised)',
                    color: isEnabled ? '#fff' : 'var(--text-muted)',
                  }}
                >
                  {pendingSwitch === item.id ? 'Saving…' : preference === undefined ? 'Unavailable' : isEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            );
          })}
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
            real-money order routing. Real funds are never at risk. SmartExit operates exclusively in high-fidelity
            authenticated exchange Demo / Testnet API execution mode.
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
            {sandboxProviders.map((exchange) => {
              const isSelected = exchange.id === selected;
              const envOption = environments.get(exchange.id);
              const cardBadge = getExchangeBadge(envOption);
              const tradeStatus = !envOption ? 'Provider status unavailable' :
                envOption.available && envOption.customerTradingReady ? 'Provider enabled for customer trading' :
                  'Customer trading unavailable';
              return (
                <button
                  key={exchange.id}
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
                  onClick={() => setSelected(exchange.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="mono" style={{ color: isSelected ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {exchange.id}
                    </span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 99,
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: 'DM Mono',
                        backgroundColor: cardBadge.bg,
                        color: cardBadge.color,
                      }}
                    >
                      {cardBadge.label}
                    </span>
                  </div>
                  <strong style={{ fontSize: 16 }}>{exchange.name}</strong>
                  <small className="muted">{exchange.environment} · {tradeStatus}</small>
                </button>
              );
            })}
          </div>

          {error && <p className="error" role="status">{error}</p>}

          {/* Selected Exchange Form */}
          {selected === 'BINANCE' ? (
            <BinanceForm />
          ) : (
            <GenericExchangeCredentials
              key={selected}
              exchange={selected}
              name={chosen.name}
              environment={chosen.environment}
              requiresPassphrase={selected === 'OKX' || selected === 'BITGET'}
            />
          )}
        </>
      )}
    </section>
  );
}
