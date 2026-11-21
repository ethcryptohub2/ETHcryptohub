'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { AdminDemoProvider, AdminDemoProviderEnvironment } from '../../../../lib/admin-demo-provider-contract';
import styles from './exchange-demo-review.module.css';

type Readiness = { state: string; enabled: boolean; removalEnabled: boolean; configured: boolean; updatedAt: string | null };
const readReasons: Record<string, string> = {
  UNSUPPORTED: 'This provider has no verified signed Demo read adapter.',
  APPROVAL_REQUIRED: 'Signed Demo reads await a separate provider-specific approval.',
  DURABLE_CLAIM_REQUIRED: 'Signed Demo reads require a one-time approval record shared across Preview instances.',
};
const reasons: Record<string, string> = {
  OUTSIDE_STAGING: 'Credential storage requires the exact approved Staging Preview.',
  ENCRYPTION_REQUIRED: 'Staging encryption must be configured before credential entry.',
  SCHEMA_REQUIRED: 'The reviewed Staging credential schema is required.',
  ADMIN_DEMO_IDENTITY_REQUIRED: 'An active Admin Demo identity is required.',
  APPROVAL_REQUIRED: 'Credential storage awaits a provider-specific approval window.',
  READY: 'Encrypted storage is available. Signed provider tests require separate approval.',
};

export function DemoCredentialStorage({ provider, environment, name, passphrase }: {
  provider: AdminDemoProvider; environment: AdminDemoProviderEnvironment; name: string; passphrase: boolean;
}) {
  const endpoint = `/api/admin/demo/providers/${provider}/credential-storage`;
  const readEndpoint = `/api/admin/demo/providers/${provider}/approved-read`;
  const [status, setStatus] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [readState, setReadState] = useState<string | null>(null);
  const enabled = status?.enabled === true;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json() as { data: Readiness };
      setStatus(body.data);
    }).catch(() => {
      if (!controller.signal.aborted) setStatus({ state: 'UNAVAILABLE', enabled: false, removalEnabled: false, configured: false, updatedAt: null });
    });
    void fetch(readEndpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = response.ok ? await response.json() as { data?: { state?: string } } : null;
      setReadState(body?.data?.state ?? 'UNAVAILABLE');
    }).catch(() => { if (!controller.signal.aborted) setReadState('UNAVAILABLE'); });
    return () => controller.abort();
  }, [endpoint, readEndpoint, revision]);

  async function mutate(method: 'POST' | 'DELETE', body?: string) {
    setBusy(true);
    setMessage('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const token = (await csrfResponse.json() as { data?: { csrfToken?: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('Session unavailable');
      const response = await fetch(endpoint, { method,
        headers: { 'X-CSRF-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }) });
      if (!response.ok) throw new Error('Unavailable');
      setMessage(method === 'POST' ? 'Encrypted credential stored with execution disabled.' : 'Credential removal completed. Audit records are retained.');
    } catch {
      setMessage('Credential change could not be confirmed. Check the saved status before retrying.');
    } finally {
      setBusy(false);
      setRevision(value => value + 1);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || busy) return;
    const fields = new FormData(event.currentTarget);
    const body = JSON.stringify({
      apiKey: fields.get('apiKey'), apiSecret: fields.get('apiSecret'),
      ...(passphrase ? { passphrase: fields.get('passphrase') } : {}),
      ownerConfirmed: fields.get('ownerConfirmed') === 'on', environment,
    });
    event.currentTarget.reset();
    void mutate('POST', body);
  }

  return <section className="card" aria-labelledby="demo-credentials-heading">
    <h2 id="demo-credentials-heading">Credentials</h2>
    <p id="demo-credential-reason" className="muted">
      {status ? reasons[status.state] ?? 'Encrypted credential readiness is unavailable.' : 'Checking encrypted credential readiness…'}
    </p>
    {status?.configured && <p>Encrypted credential stored. {status.updatedAt && `Updated ${status.updatedAt}.`}</p>}
    <form onSubmit={save}>
      <fieldset disabled={!enabled || busy} className={styles.credentialFields} aria-describedby="demo-credential-reason">
        <legend className={styles.visuallyHidden}>{name} {environment} credentials</legend>
        <label className={styles.field}>API key<input name="apiKey" type="password" autoComplete="off" required minLength={8} maxLength={256} /></label>
        <label className={styles.field}>API secret<input name="apiSecret" type="password" autoComplete="off" required minLength={8} maxLength={512} /></label>
        {passphrase && <label className={styles.field}>Passphrase<input name="passphrase" type="password" autoComplete="off" required maxLength={256} /></label>}
        <label><input type="checkbox" name="ownerConfirmed" required /> These credentials belong to my dedicated {environment} account.</label>
        <div className={styles.actions}>
          <button type="submit">Save credentials</button>
          <button type="button" disabled={!status?.removalEnabled} className="button-secondary"
            onClick={() => { if (status?.removalEnabled && !busy && window.confirm('Remove stored Demo credential values for this provider in Staging?')) void mutate('DELETE'); }}>
            Remove credential
          </button>
        </div>
      </fieldset>
    </form>
    <p className="muted">{readState ? readReasons[readState] ?? 'Signed Demo read readiness is unavailable.' : 'Checking signed Demo read readiness…'}</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
