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

  return <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
    <p className="mono">{exchange} · {environment} / VIRTUAL FUNDS</p>
    <p className="muted">
      {status?.configured
        ? `Configured ${status.maskedApiKey ?? ''} · ${status.lastVerifiedAt ? `last connection check ${new Date(status.lastVerifiedAt).toLocaleString()}` : 'not tested'}`
        : status?.environmentConfirmationRequired
          ? `A legacy credential exists but its original environment is unverified. Re-enter a dedicated ${name} ${environment} key before connecting.`
          : `No ${name} ${environment} credentials are saved.`}
      {' '}Use a {name} {environment} API key with read and derivatives-trading permission only. Keep withdrawals and transfers disabled.
    </p>
    <label>{name} {environment} API Key<input autoComplete="off" value={apiKey} minLength={8} maxLength={256} onChange={(event) => setApiKey(event.target.value)} required /></label>
    <label>{name} {environment} API Secret<input type="password" autoComplete="new-password" value={apiSecret} minLength={8} maxLength={512} onChange={(event) => setApiSecret(event.target.value)} required /></label>
    {requiresPassphrase && (
      <label>{name} API Passphrase<input type="password" autoComplete="new-password" value={passphrase} minLength={1} maxLength={256} onChange={(event) => setPassphrase(event.target.value)} required /></label>
    )}
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}
    <div className="links">
      <button disabled={busy}>Save encrypted keys</button>
      <button type="button" className="button-secondary" disabled={busy || !status?.configured} onClick={(event) => void submit(event, 'test')}>Test Demo connection</button>
      <button type="button" className="button-secondary" disabled={busy || !status?.configured} onClick={(event) => void submit(event, 'remove')}>Remove Demo keys</button>
    </div>
    <p className="muted">The API endpoint is fixed server-side. This connection test checks account-read access only and never places orders.</p>
  </form>;
}

export function ExchangeConnections() {
  const [exchanges, setExchanges] = useState<ExchangeOption[]>([
    {
      exchange: 'BINANCE',
      name: 'Binance',
      environments: [
        { environment: 'DEMO', enabled: false, supported: true, available: false, customerTradingReady: false },
        { environment: 'LIVE', enabled: false, supported: true, available: false, customerTradingReady: false },
      ],
    },
    { exchange: 'BYBIT', name: 'Bybit', environments: [{ environment: 'DEMO', enabled: false, supported: true, available: false, customerTradingReady: false }] },
    { exchange: 'OKX', name: 'OKX', environments: [{ environment: 'DEMO', enabled: false, supported: false, available: false, customerTradingReady: false }] },
    { exchange: 'BITGET', name: 'Bitget', environments: [{ environment: 'DEMO', enabled: false, supported: false, available: false, customerTradingReady: false }] },
    { exchange: 'GATE', name: 'Gate.io', environments: [{ environment: 'TESTNET', enabled: false, supported: false, available: false, customerTradingReady: false }] },
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
  return <section className="stack">
    <label>Exchange<select value={selected} onChange={(event) => setSelected(event.target.value)}>
      {exchanges.map((exchange) => <option value={exchange.exchange} key={exchange.exchange}>{exchange.name}</option>)}
    </select></label>
    {error && <p className="muted" role="status">{error}</p>}
    {selected === 'BINANCE'
      ? <BinanceForm />
      : demo?.available
        ? <GenericExchangeCredentials
            exchange={selected}
            name={chosen?.name ?? selected}
            environment={(demo.environment as 'DEMO' | 'TESTNET') ?? 'DEMO'}
            requiresPassphrase={selected === 'OKX' || selected === 'BITGET'}
          />
        : <p className="muted">
            {!demo?.supported
              ? 'NOT IMPLEMENTED — DISABLED. Admin has not enabled this exchange.'
              : 'This exchange environment is disabled by the administrator. No connection or trading action is available.'}
          </p>}
  </section>;
}
