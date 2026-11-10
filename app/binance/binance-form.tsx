'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Environment = 'DEMO' | 'LIVE';

export function BinanceForm() {
  const [environment, setEnvironment] = useState<Environment>('DEMO');
  const [configured, setConfigured] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/api/binance?environment=${environment}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: { configured: boolean }; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load Binance settings.');
        if (active) setConfigured(body.data.configured);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load Binance settings.');
      });
    return () => { active = false; };
  }, [environment]);

  function selectEnvironment(next: Environment) {
    setEnvironment(next);
    setConfigured(false);
    setApiKey('');
    setApiSecret('');
    setMessage('');
    setError('');
  }

  async function submit(event: FormEvent, action: 'save' | 'test' | 'remove') {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/binance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken }, body: JSON.stringify({ action, environment, ...(action === 'save' ? { apiKey, apiSecret } : {}) }) });
      const body = await response.json() as { data?: { configured?: boolean; connected?: boolean; environment?: Environment }; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Binance request failed.');
      if (action === 'remove') setConfigured(false);
      if (action === 'save') { setConfigured(true); setApiKey(''); setApiSecret(''); }
      setMessage(body.data?.connected ? `${environment === 'DEMO' ? 'Demo' : 'Live'} Binance account-read permission verified. No orders were placed.` : action === 'remove' ? `${environment === 'DEMO' ? 'Demo' : 'Live'} credentials removed.` : `${environment === 'DEMO' ? 'Demo' : 'Live'} credentials encrypted and saved.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Binance request failed.'); }
    finally { setBusy(false); }
  }
  return <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
    <div className="links" role="tablist" aria-label="Binance API environment">
      <button type="button" role="tab" aria-selected={environment === 'DEMO'} className={environment === 'DEMO' ? '' : 'button-secondary'} onClick={() => selectEnvironment('DEMO')}>Demo API</button>
      <button type="button" role="tab" aria-selected={environment === 'LIVE'} className={environment === 'LIVE' ? '' : 'button-secondary'} onClick={() => selectEnvironment('LIVE')}>Live API</button>
    </div>
    <p className="mono">{environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
    <p className="muted">{configured ? 'Credentials are stored; secret values cannot be viewed.' : `No ${environment === 'DEMO' ? 'Demo' : 'Live'} credentials are saved.`} Keep withdrawals disabled on the exchange API key.</p>
    <label>{environment === 'DEMO' ? 'Demo' : 'Live'} Binance API key<input autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} minLength={20} maxLength={128} required /></label>
    <label>{environment === 'DEMO' ? 'Demo' : 'Live'} Binance API secret<input autoComplete="new-password" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} minLength={20} maxLength={128} required /></label>
    {message && <p className="success" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="links"><button disabled={busy}>Save encrypted keys</button><button type="button" disabled={busy || !configured} onClick={(event) => void submit(event, 'test')}>Test {environment === 'DEMO' ? 'Demo' : 'Live'} account access</button><button type="button" disabled={busy || !configured} onClick={(event) => void submit(event, 'remove')}>Remove {environment === 'DEMO' ? 'Demo' : 'Live'} keys</button></div>
    <p className="muted">The API endpoint is fixed server-side. Credentials and connection checks are isolated by environment; no orders are placed by this form.</p>
  </form>;
}
