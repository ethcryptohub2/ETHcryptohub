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

function BybitDemoCredentials() {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadStatus() {
    const response = await fetch('/api/exchanges/credentials?exchange=BYBIT&environment=DEMO', { cache: 'no-store' });
    const body = await response.json() as { data?: CredentialStatus; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Bybit Demo connection settings are unavailable.');
    return body.data;
  }

  useEffect(() => {
    let active = true;
    void loadStatus()
      .then((data) => { if (active) setStatus(data); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Bybit Demo settings are unavailable.');
      });
    return () => { active = false; };
  }, []);

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
          exchange: 'BYBIT',
          environment: 'DEMO',
          ...(action === 'save' ? { apiKey, apiSecret } : {}),
        }),
      });
      const body = await response.json() as { data?: CredentialStatus; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Bybit Demo request failed.');
      setStatus(body.data);
      if (action === 'save') {
        setApiKey('');
        setApiSecret('');
      }
      setMessage(action === 'test'
        ? 'Bybit Demo account access verified. No orders were placed.'
        : action === 'remove'
          ? 'Bybit Demo credentials removed.'
          : 'Bybit Demo credentials encrypted and saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Bybit Demo request failed.');
    } finally {
      setBusy(false);
    }
  }

  return <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
    <p className="mono">BYBIT · DEMO / VIRTUAL FUNDS</p>
    <p className="muted">
      {status?.configured
        ? `Configured ${status.maskedApiKey ?? ''} · ${status.lastVerifiedAt ? `last connection check ${new Date(status.lastVerifiedAt).toLocaleString()}` : 'not tested'}`
        : status?.environmentConfirmationRequired
          ? 'A legacy credential exists but its original environment is unverified. Re-enter a dedicated Bybit Demo key before connecting.'
          : 'No Bybit Demo credentials are saved.'}
      {' '}Use a Bybit Demo API key with read and derivatives-trading permission only. Keep withdrawals and transfers disabled.
    </p>
    <label>Bybit Demo API Key<input autoComplete="off" value={apiKey} minLength={8} maxLength={256} onChange={(event) => setApiKey(event.target.value)} required /></label>
    <label>Bybit Demo API Secret<input type="password" autoComplete="new-password" value={apiSecret} minLength={8} maxLength={512} onChange={(event) => setApiSecret(event.target.value)} required /></label>
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
        { environment: 'DEMO', enabled: true, supported: true, available: true, customerTradingReady: true },
        { environment: 'LIVE', enabled: true, supported: true, available: true, customerTradingReady: true },
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
    {error && <p className="error" role="alert">{error} Binance connections remain available through the existing settings.</p>}
    {selected === 'BINANCE'
      ? <BinanceForm />
      : selected === 'BYBIT' && demo?.available
        ? <BybitDemoCredentials />
        : <p className="muted">
            {!demo?.supported
              ? 'NOT IMPLEMENTED — DISABLED. Admin has not enabled this exchange.'
              : 'This exchange environment is disabled by the administrator. No connection or trading action is available.'}
          </p>}
  </section>;
}
