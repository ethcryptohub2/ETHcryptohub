'use client';

import { useState } from 'react';
import {
  ADMIN_DEMO_PROVIDERS,
  ADMIN_DEMO_PROVIDER_ENVIRONMENTS,
  isAdminDemoProvider,
  type AdminDemoProvider,
} from '../../../../lib/admin-demo-provider-contract';
import styles from './exchange-demo-review.module.css';

const providerDetails = {
  BINANCE: { name: 'Binance USD-M', passphrase: false, lifecycle: 'Existing isolated test harness' },
  BYBIT: { name: 'Bybit', passphrase: false, lifecycle: 'Mock-tested lifecycle' },
  OKX: { name: 'OKX', passphrase: true, lifecycle: 'Blocked pending lifecycle adapter review' },
  BITGET: { name: 'Bitget', passphrase: true, lifecycle: 'Blocked pending lifecycle adapter review' },
  GATE: { name: 'Gate.io Futures', passphrase: false, lifecycle: 'Blocked pending lifecycle adapter review' },
} satisfies Record<AdminDemoProvider, { name: string; passphrase: boolean; lifecycle: string }>;

const accountPanels = [
  ['Balances', 'No approved account snapshot.'],
  ['Positions', 'No approved position snapshot.'],
  ['Orders', 'No approved order lookup.'],
  ['History', 'No approved account history.'],
  ['Test results', 'No remote test results available in this review.'],
] as const;

export function ExchangeDemoReview() {
  const [provider, setProvider] = useState<AdminDemoProvider>('BINANCE');
  const { name, passphrase, lifecycle } = providerDetails[provider];
  const environment = ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider];

  return (
    <div className={styles.lab}>
      <section className={`card ${styles.selection}`} aria-labelledby="demo-provider-heading">
        <div>
          <h2 id="demo-provider-heading">Provider</h2>
          <label className={styles.field}>
            Exchange
            <select value={provider} onChange={(event) => {
              const value = event.target.value;
              if (isAdminDemoProvider(value)) setProvider(value);
            }}>
              {ADMIN_DEMO_PROVIDERS.map((id) => (
                <option key={id} value={id}>{providerDetails[id].name}</option>
              ))}
            </select>
          </label>
        </div>
        <div aria-live="polite">
          <span className={styles.badge}>{environment}</span>
          <h3>{name}</h3>
          <p className="muted">Mock-tested. Remote connection blocked pending schema and credential approval.</p>
        </div>
      </section>

      <div className={styles.columns}>
        <section className="card" aria-labelledby="demo-credentials-heading">
          <h2 id="demo-credentials-heading">Credentials</h2>
          <p id="demo-credential-reason" className="muted">
            Blocked pending encrypted storage verification and {name} credential setup approval.
          </p>
          <fieldset disabled className={styles.credentialFields} aria-describedby="demo-credential-reason">
            <legend className={styles.visuallyHidden}>{name} {environment} credentials</legend>
            <label className={styles.field}>API key<input type="password" autoComplete="off" /></label>
            <label className={styles.field}>API secret<input type="password" autoComplete="off" /></label>
            {passphrase && <label className={styles.field}>Passphrase<input type="password" autoComplete="off" /></label>}
            <button type="button">Save credentials</button>
          </fieldset>
        </section>

        <section className="card" aria-labelledby="demo-approvals-heading">
          <h2 id="demo-approvals-heading">{name} approvals</h2>
          <ol className={styles.approvals}>
            <li>Credential setup requires dedicated {environment} credentials and verified Staging encryption and schema.</li>
            <li>Connection testing requires separate approval for this provider’s authenticated reads.</li>
            <li>Execution requires separate approval for an individual {environment} test and verified lifecycle protections.</li>
          </ol>
          <p id="demo-execution-reason" className="muted">
            No session is active in this lab. Remote connection checks and execution are disabled.
          </p>
          <div className={styles.actions} aria-describedby="demo-execution-reason">
            <button type="button" disabled>Test connection</button>
            <button type="button" disabled>Start test</button>
            <button type="button" disabled>Stop test</button>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="demo-capabilities-heading">
        <h2 id="demo-capabilities-heading">Capability matrix</h2>
        <dl className={styles.capabilities}>
          <div><dt>Authenticated account reads</dt><dd>Blocked pending connection approval</dd></div>
          <div><dt>Staging schema</dt><dd>Blocked pending migration and access verification</dd></div>
          <div><dt>Credential storage</dt><dd>Blocked pending encrypted storage verification</dd></div>
          <div><dt>Order placement and cancellation</dt><dd>Blocked pending execution approval</dd></div>
          <div><dt>Protection and reconciliation</dt><dd>{lifecycle}. Remote execution blocked.</dd></div>
          <div><dt>Verified Demo executions</dt><dd>No authorized remote execution evidence</dd></div>
        </dl>
      </section>

      <section className="card" aria-labelledby="demo-account-heading">
        <h2 id="demo-account-heading">Account and test evidence</h2>
        <dl className={styles.evidence}>
          {accountPanels.map(([label, status]) => (
            <div key={label}><dt>{label}</dt><dd>{status}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
