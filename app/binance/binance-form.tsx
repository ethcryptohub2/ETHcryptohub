'use client';

import { useEffect, useState, type FormEvent } from 'react';

export function BinanceForm() {
  const [configured, setConfigured] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void fetch('/api/binance').then(async (r) => { const b = await r.json() as { data?: { configured: boolean } }; if (r.ok) setConfigured(b.data?.configured ?? false); }).catch(() => setError('Could not load Binance settings.')); }, []);
  async function submit(event: FormEvent, action: 'save' | 'test' | 'remove') {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/binance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken }, body: JSON.stringify({ action, apiKey, apiSecret }) });
      const body = await response.json() as { data?: { configured?: boolean; connected?: boolean }; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Binance request failed.');
      if (action === 'remove') setConfigured(false);
      if (action === 'save') { setConfigured(true); setApiKey(''); setApiSecret(''); }
      setMessage(body.data?.connected ? 'Binance account-read permission verified. No orders were placed.' : action === 'remove' ? 'Credentials removed.' : 'Credentials encrypted and saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Binance request failed.'); }
    finally { setBusy(false); }
  }
  return <form className="card stack" onSubmit={(event) => void submit(event, 'save')}><p className="muted">{configured ? 'Credentials are stored; secret values cannot be viewed.' : 'No Binance credentials are saved.'} Keep withdrawals disabled on the exchange API key.</p><label>Binance API key<input autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} minLength={20} maxLength={128} required /></label><label>Binance API secret<input autoComplete="new-password" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} minLength={20} maxLength={128} required /></label>{message && <p className="success">{message}</p>}{error && <p className="error">{error}</p>}<div className="links"><button disabled={busy}>Save encrypted keys</button><button type="button" disabled={busy || !configured} onClick={(event) => void submit(event, 'test')}>Test account access</button><button type="button" disabled={busy || !configured} onClick={(event) => void submit(event, 'remove')}>Remove</button></div><p className="muted">Live order submission is disabled.</p></form>;
}
