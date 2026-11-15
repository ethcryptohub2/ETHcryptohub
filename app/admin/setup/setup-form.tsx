'use client';

import { useEffect, useState, type FormEvent } from 'react';

type SetupStatus = 'checking' | 'available' | 'complete' | 'unavailable';
type SetupStatusResponse = {
  data?: { setupAvailable?: unknown };
  error?: string;
};

export function AdminSetupForm() {
  const [error, setError] = useState('');
  const [availabilityError, setAvailabilityError] = useState('');
  const [setupStatus, setSetupStatus] = useState<SetupStatus>('checking');
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkSetupStatus() {
      try {
        const response = await fetch('/api/admin/setup', { cache: 'no-store' });
        const body = await response.json() as SetupStatusResponse;
        if (!response.ok) throw new Error(body.error ?? 'Could not verify administrator setup status.');
        if (typeof body.data?.setupAvailable !== 'boolean') {
          throw new Error('Could not verify administrator setup status.');
        }
        if (active) setSetupStatus(body.data.setupAvailable ? 'available' : 'complete');
      } catch (reason) {
        if (!active) return;
        setAvailabilityError(reason instanceof Error ? reason.message : 'Could not verify administrator setup status.');
        setSetupStatus('unavailable');
      }
    }

    void checkSetupStatus();
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setupStatus !== 'available') {
      setError('Administrator setup is no longer available. Refresh to check the status.');
      return;
    }
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json() as { data?: { csrfToken?: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ email: form.get('email'), password: form.get('password'), confirmation: form.get('confirmation'), setupToken: form.get('setupToken') }) });
      const body = await response.json() as { error?: string };
      if (response.status === 410) {
        setSetupStatus('complete');
        return;
      }
      if (!response.ok) throw new Error(body.error ?? 'Admin setup failed.');
      setComplete(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Admin setup failed.'); }
    finally { setBusy(false); }
  }

  if (complete) return <p className="success">Administrator created. Sign in with the configured email and password. Remove ADMIN_SETUP_TOKEN from Vercel after setup.</p>;

  if (setupStatus === 'checking') return <p role="status">Checking whether administrator setup is available…</p>;
  if (setupStatus === 'complete') return <p className="success">Initial administrator setup is already complete. Sign in to continue.</p>;
  if (setupStatus === 'unavailable') return <p className="error">{availabilityError}</p>;

  return (
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <label>Email<input name="email" type="email" maxLength={255} required /></label>
      <label>Password<input name="password" type="password" minLength={12} maxLength={72} required /></label>
      <label>Confirm password<input name="confirmation" type="password" minLength={12} maxLength={72} required /></label>
      <label>Setup token<input name="setupToken" type="password" autoComplete="off" required /></label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Setting up…' : 'Create administrator'}</button>
    </form>
  );
}
