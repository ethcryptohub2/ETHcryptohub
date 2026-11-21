'use client';

import { useEffect, useState, type FormEvent } from 'react';

type Environment = 'DEMO' | 'LIVE';

export function BinanceForm() {
  const [environment, setEnvironment] = useState<Environment>('DEMO');
  const [configured, setConfigured] = useState(false);
  const [environmentConfirmationRequired, setEnvironmentConfirmationRequired] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [signedReadEnabled, setSignedReadEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/binance?environment=${environment}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { data?: { configured: boolean; environmentConfirmationRequired?: boolean; signedReadEnabled?: boolean }; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load Binance settings.');
        if (!controller.signal.aborted) {
          setConfigured(body.data.configured);
          setEnvironmentConfirmationRequired(body.data.environmentConfirmationRequired ?? false);
          setSignedReadEnabled(body.data.signedReadEnabled === true);
          setStorageReady(true);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load Binance settings.');
      });
    return () => controller.abort();
  }, [environment]);

  function selectEnvironment(next: Environment) {
    if (next === environment || busy) return;
    setEnvironment(next);
    setStorageReady(false);
    setSignedReadEnabled(false);
    setConfigured(false);
    setEnvironmentConfirmationRequired(false);
    setApiKey('');
    setApiSecret('');
    setConfirmed(false);
    setMessage('');
    setError('');
  }

  async function submit(event: FormEvent, action: 'save' | 'test' | 'remove') {
    event.preventDefault();
    if (!storageReady || busy || (action === 'save' && !confirmed) || (action === 'test' && !signedReadEnabled)) return;
    setBusy(true); setMessage(''); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/binance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken }, body: JSON.stringify({ action, environment, ...(action === 'save' ? { apiKey, apiSecret, confirmCredentialEnvironment: confirmed } : {}) }) });
      const body = await response.json() as { data?: { configured?: boolean; connected?: boolean; environment?: Environment }; code?: string; error?: string };
      if (!response.ok) {
        if (body.code === 'SIGNED_READ_BLOCKED') setSignedReadEnabled(false);
        if (body.code === 'SCHEMA_BLOCKED' || body.code === 'ENCRYPTION_BLOCKED' || body.code === 'ADMIN_APPROVAL_REQUIRED') {
          setStorageReady(false);
          setApiKey('');
          setApiSecret('');
          setConfirmed(false);
        }
        throw new Error(body.error ?? 'Binance request failed.');
      }
      if (action === 'remove') {
        setConfigured(false);
        setEnvironmentConfirmationRequired(false);
      }
      if (action === 'save') {
        setConfigured(true);
        setEnvironmentConfirmationRequired(false);
        setApiKey('');
        setApiSecret('');
        setConfirmed(false);
      }
      const label = environment === 'DEMO' ? 'Demo' : 'Live';
      if (action === 'test' && body.data?.connected !== true) throw new Error('Binance returned no account verification result.');
      setMessage(action === 'test'
        ? `${label} Binance account-read permission verified. No orders were placed.`
        : action === 'remove' ? `${label} credentials removed.` : `${label} credentials encrypted and saved.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Binance request failed.'); }
    finally { setBusy(false); }
  }
  return <form className="card stack" onSubmit={(event) => void submit(event, 'save')}>
    <div className="links" role="tablist" aria-label="Binance API environment">
      <button type="button" role="tab" disabled={busy} aria-selected={environment === 'DEMO'} className={environment === 'DEMO' ? '' : 'button-secondary'} onClick={() => selectEnvironment('DEMO')}>Demo API</button>
      <button type="button" role="tab" disabled={busy} aria-selected={environment === 'LIVE'} className={environment === 'LIVE' ? '' : 'button-secondary'} onClick={() => selectEnvironment('LIVE')}>Live API</button>
    </div>
    <p className="mono">{environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
    <p className={environmentConfirmationRequired ? 'scanner-warning' : 'muted'} role={environmentConfirmationRequired ? 'status' : undefined}>
      {!storageReady
        ? error ? 'Credential entry is blocked.' : 'Checking whether credential storage is available…'
        : environmentConfirmationRequired
        ? `A legacy credential exists for ${environment}, but its original environment cannot be verified. Re-enter the matching ${environment === 'DEMO' ? 'Demo' : 'Live'} credential before using it.`
        : configured
          ? 'Credentials are stored; secret values cannot be viewed.'
          : `No ${environment === 'DEMO' ? 'Demo' : 'Live'} credentials are saved.`}
      {storageReady && ' Keep withdrawals disabled on the exchange API key.'}
    </p>
    {message && <p className="success" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <label>{environment === 'DEMO' ? 'Demo' : 'Live'} Binance API key<input type="password" autoComplete="off" disabled={busy || !storageReady} value={apiKey} onChange={(e) => setApiKey(e.target.value)} minLength={20} maxLength={128} required /></label>
    <label>{environment === 'DEMO' ? 'Demo' : 'Live'} Binance API secret<input autoComplete="new-password" type="password" disabled={busy || !storageReady} value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} minLength={20} maxLength={128} required /></label>
    <label><input type="checkbox" checked={confirmed} disabled={busy || !storageReady} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm these keys were issued for Binance {environment === 'DEMO' ? 'Demo' : 'Live'}.</label>
    <div className="links"><button disabled={busy || !storageReady || !confirmed}>Save encrypted keys</button><button type="button" disabled={busy || !storageReady || !configured || !signedReadEnabled} onClick={(event) => void submit(event, 'test')}>Test {environment === 'DEMO' ? 'Demo' : 'Live'} account access</button><button type="button" disabled={busy || !storageReady || (!configured && !environmentConfirmationRequired)} onClick={(event) => void submit(event, 'remove')}>Remove {environment === 'DEMO' ? 'Demo' : 'Live'} keys</button></div>
    {storageReady && !signedReadEnabled && <p className="muted">Account verification requires separate approval.</p>}
    <p className="muted">The API endpoint is fixed server-side. Credentials and connection checks are isolated by environment; no orders are placed by this form.</p>
  </form>;
}
