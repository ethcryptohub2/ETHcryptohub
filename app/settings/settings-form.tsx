'use client';

import { useState, type FormEvent } from 'react';

export function SettingsForm({ initialHandle }: { initialHandle: string }) {
  const [handle, setHandle] = useState(initialHandle);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(''); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      if (!csrfResponse.ok || !csrfBody.data) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.data.csrfToken }, body: JSON.stringify({ xHandle: handle }) });
      const body = await response.json() as { error?: string; data?: { xHandle: string | null } };
      if (!response.ok) throw new Error(body.error ?? 'Settings update failed.');
      setHandle(body.data?.xHandle ?? '');
      setMessage('Settings saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Settings update failed.'); }
    finally { setBusy(false); }
  }
  return <form className="card stack" onSubmit={(event) => void submit(event)}><label>X handle<input value={handle} onChange={(event) => setHandle(event.target.value)} maxLength={100} placeholder="@yourhandle" /></label><p className="muted">Verification is reviewed by an administrator. Saving a handle does not automatically verify it.</p>{message && <p className="success">{message}</p>}{error && <p className="error">{error}</p>}<button disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></form>;
}
