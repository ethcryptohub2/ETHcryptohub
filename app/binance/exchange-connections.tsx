'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
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

export function getExchangeBadge(params: {
  exchange: string;
  environment: string;
  configured: boolean;
  lastVerifiedAt?: string | null;
  hasError?: boolean;
  switchEnabled?: boolean;
  isLiveMode?: boolean;
  adapterComplete?: boolean;
  lastOrderVerified?: boolean;
}) {
  const {
    exchange,
    environment,
    configured,
    lastVerifiedAt,
    hasError,
    switchEnabled = true,
    isLiveMode = false,
    adapterComplete = exchange === 'BINANCE' || exchange === 'BYBIT',
    lastOrderVerified = false,
  } = params;

  if (isLiveMode || environment === 'LIVE') {
    return { label: '🔒 LIVE LOCKED', color: '#991b1b', bg: '#fee2e2' };
  }
  if (!switchEnabled) {
    return { label: '○ DISABLED', color: 'var(--text-muted)', bg: 'var(--surface-raised)' };
  }
  if (!configured) {
    return { label: '○ NOT CONFIGURED', color: '#6b7280', bg: 'var(--surface-raised)' };
  }
  if (hasError) {
    return { label: '✕ CREDENTIALS INVALID', color: '#b91c1c', bg: '#fef2f2' };
  }
  if (!adapterComplete) {
    return { label: '⚠ ADAPTER INCOMPLETE', color: '#b45309', bg: '#fffbeb' };
  }
  if (lastOrderVerified) {
    return { label: '✓ DEMO ORDER VERIFIED', color: '#047857', bg: '#ecfdf5' };
  }
  if (lastVerifiedAt && switchEnabled) {
    return { label: '● DEMO EXECUTION ENABLED', color: '#166534', bg: '#f0fdf4' };
  }
  if (lastVerifiedAt) {
    return { label: '● DEMO CONNECTED', color: '#15803d', bg: '#f0fdf4' };
  }
  return { label: '● CONFIGURED', color: '#15803d', bg: '#f0fdf4' };
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
  switchEnabled = true,
  onCredentialChange,
}: {
  exchange: string;
  name: string;
  environment: 'DEMO' | 'TESTNET';
  requiresPassphrase?: boolean;
  switchEnabled?: boolean;
  onCredentialChange?: () => void;
}) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const badgeInfo = getExchangeBadge({
    exchange,
    environment,
    configured: Boolean(status?.configured),
    lastVerifiedAt: status?.lastVerifiedAt,
    hasError: Boolean(error),
    switchEnabled,
    isLiveMode: false,
    adapterComplete: exchange === 'BINANCE' || exchange === 'BYBIT',
  });

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
      onCredentialChange?.();
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
  const [activeMode, setActiveMode] = useState<'demo' | 'live'>('demo');
  const [exchangeSwitches, setExchangeSwitches] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {
      BINANCE: true,
      BYBIT: true,
      OKX: false,
      BITGET: false,
      GATE: true,
    };
    if (typeof window === 'undefined') return defaults;
    try {
      const stored = window.localStorage.getItem('smartexit_exchange_switches');
      if (stored) return { ...defaults, ...(JSON.parse(stored) as Record<string, boolean>) };
    } catch {}
    return defaults;
  });

  const toggleExchangeSwitch = (exchangeId: string) => {
    const nextValue = !exchangeSwitches[exchangeId];
    const targetEnv = exchangeId === 'GATE' ? 'TESTNET' : 'DEMO';
    setExchangeSwitches((prev) => {
      const next = { ...prev, [exchangeId]: nextValue };
      try {
        localStorage.setItem('smartexit_exchange_switches', JSON.stringify(next));
      } catch {}
      return next;
    });
    void (async () => {
      try {
        const csrfToken = await getCsrfToken();
        const res = await fetch('/api/exchanges', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ exchange: exchangeId, environment: targetEnv, enabled: nextValue }),
        });
        if (!res.ok) {
          throw new Error('Could not persist exchange execution switch.');
        }
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update exchange switch.');
      }
    })();
  };

  useEffect(() => {
    let active = true;
    const syncSwitchesFromProviders = (providerList: ExchangeOption[]) => {
      setExchangeSwitches((prev) => {
        const merged = { ...prev };
        for (const p of providerList) {
          const demoEnv = p.environments.find((e) => e.environment === 'DEMO' || e.environment === 'TESTNET');
          if (demoEnv && typeof demoEnv.userAutoTradeEnabled === 'boolean') {
            merged[p.exchange] = demoEnv.userAutoTradeEnabled;
          }
        }
        return merged;
      });
    };
    void fetch('/api/exchanges', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as { data?: ExchangeOption[]; error?: string };
        const providerList = body.data;
        if (!response.ok || !providerList) throw new Error(body.error ?? 'Exchange list unavailable.');
        if (active) {
          setExchanges(providerList);
          syncSwitchesFromProviders(providerList);
          setSelected((previous) =>
            providerList.some((item) => item.exchange === previous) ? previous : 'BINANCE',
          );
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Exchange list unavailable.');
      });
    const handleCredentialSync = () => {
      void fetch('/api/exchanges', { cache: 'no-store' })
        .then(async (response) => {
          const body = (await response.json()) as { data?: ExchangeOption[] };
          if (body.data) {
            setExchanges(body.data);
            syncSwitchesFromProviders(body.data);
          }
        })
        .catch(() => {});
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('smartexit-exchange-credential-synced', handleCredentialSync);
    }
    return () => {
      active = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('smartexit-exchange-credential-synced', handleCredentialSync);
      }
    };
  }, []);

  const refreshExchanges = useCallback(() => {
    void fetch('/api/exchanges', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as { data?: ExchangeOption[] };
        if (body.data) setExchanges(body.data);
      })
      .catch(() => {});
  }, []);

  const chosen = exchanges.find((exchange) => exchange.exchange === selected);
  const demo = chosen?.environments.find(
    (environment) => environment.environment === 'DEMO' || environment.environment === 'TESTNET',
  );

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
            Execute directly on remote exchange Demo/Testnet APIs across 5 connected providers. Zero internal simulation.
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
            <strong style={{ fontSize: 14, display: 'block' }}>Multi-Exchange Execution Switches</strong>
            <small className="muted" style={{ fontSize: 12 }}>
              Enable or disable parallel execution independently for each exchange. Qualified signals fan out to ALL active destinations.
            </small>
          </div>
          <div className="mono" style={{ fontSize: 11, background: 'var(--surface)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--surface-border)' }}>
            Active: <strong style={{ color: 'var(--accent)' }}>{Object.values(exchangeSwitches).filter(Boolean).length} / 5</strong> · Aggregate Risk Cap: <strong>5.0%</strong>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          {[
            { id: 'BINANCE', name: 'Binance Futures Demo', env: 'DEMO' },
            { id: 'BYBIT', name: 'Bybit Demo', env: 'DEMO' },
            { id: 'OKX', name: 'OKX Demo', env: 'DEMO' },
            { id: 'BITGET', name: 'Bitget Demo', env: 'DEMO' },
            { id: 'GATE', name: 'Gate.io Futures', env: 'TESTNET' },
          ].map((item) => {
            const isEnabled = Boolean(exchangeSwitches[item.id]);
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
                  <small className="muted" style={{ fontSize: 10 }}>{item.env}</small>
                </div>
                <button
                  type="button"
                  onClick={() => toggleExchangeSwitch(item.id)}
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
                  {isEnabled ? '● ON' : '○ OFF'}
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
            {exchanges.map((exchange) => {
              const isSelected = exchange.exchange === selected;
              const isEnabled = Boolean(exchangeSwitches[exchange.exchange]);
              const envOption = exchange.environments.find(
                (e) => e.environment === (exchange.exchange === 'GATE' ? 'TESTNET' : 'DEMO'),
              );
              const isConfigured = Boolean(
                (envOption as { configured?: boolean })?.configured ||
                ((envOption as { configuredAccounts?: number })?.configuredAccounts &&
                (envOption as { configuredAccounts?: number }).configuredAccounts! > 0),
              );
              const cardBadge = getExchangeBadge({
                exchange: exchange.exchange,
                environment: exchange.exchange === 'GATE' ? 'TESTNET' : 'DEMO',
                configured: isConfigured,
                lastVerifiedAt: envOption?.lastVerifiedAt ?? null,
                switchEnabled: isEnabled,
                adapterComplete: exchange.exchange === 'BINANCE' || exchange.exchange === 'BYBIT',
              });
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
                        backgroundColor: cardBadge.bg,
                        color: cardBadge.color,
                      }}
                    >
                      {cardBadge.label}
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
            <BinanceForm onCredentialChange={refreshExchanges} />
          ) : (
            <GenericExchangeCredentials
              exchange={selected}
              name={chosen?.name ?? selected}
              environment={(demo?.environment as 'DEMO' | 'TESTNET') ?? (selected === 'GATE' ? 'TESTNET' : 'DEMO')}
              requiresPassphrase={selected === 'OKX' || selected === 'BITGET'}
              switchEnabled={Boolean(exchangeSwitches[selected])}
              onCredentialChange={refreshExchanges}
            />
          )}
        </>
      )}
    </section>
  );
}
