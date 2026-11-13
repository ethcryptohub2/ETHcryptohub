'use client';

import { useState, type FormEvent } from 'react';

export function AdminSetupForm({ email }: { email: string }) {
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json() as { data?: { csrfToken: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ setupToken: form.get('setupToken') }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Admin setup failed.');
      setComplete(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Admin setup failed.'); }
    finally { setBusy(false); }
  }
  if (complete) return <p className="success">Administrator access enabled for {email}. Remove ADMIN_SETUP_TOKEN from the deployment environment after setup.</p>;
  return <form className="stack" onSubmit={(event) => void submit(event)}><p>Signed in as <strong>{email}</strong>. This verified account will be the first administrator.</p><label>One-time setup token<input name="setupToken" type="password" autoComplete="off" required /></label>{error && <p className="error">{error}</p>}<button disabled={busy}>{busy ? 'Setting up…' : 'Enable administrator access'}</button></form>;
}
