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
  BINANCE: { name: 'Binance USD-M', passphrase: false, fixtures: 'Account, instruments, order and protection lifecycle' },
  BYBIT: { name: 'Bybit', passphrase: false, fixtures: 'Account, orders, protection and reconciliation' },
  OKX: { name: 'OKX', passphrase: true, fixtures: 'Account, positions, instruments, order lookup and single-order cancellation' },
  BITGET: { name: 'Bitget', passphrase: true, fixtures: 'Signed reads, instrument precision, order lookup and single-order cancellation' },
  GATE: { name: 'Gate.io Futures', passphrase: false, fixtures: 'Account, positions, contracts, order lookup and single-order cancellation' },
} satisfies Record<AdminDemoProvider, { name: string; passphrase: boolean; fixtures: string }>;

const accountPanels = [
  ['Balances', 'No approved account snapshot.'],
  ['Futures instruments', 'No approved instrument snapshot.'],
  ['Positions', 'No approved position snapshot.'],
  ['Orders', 'No approved order lookup.'],
  ['Order and execution history', 'No approved account history.'],
  ['Reconciliation', 'No authorized execution to reconcile.'],
  ['Audit trail', 'Staging audit storage has not been verified.'],
  ['Test results', 'No remote test results available in this review.'],
] as const;

export function ExchangeDemoReview() {
  const [provider, setProvider] = useState<AdminDemoProvider>('BINANCE');
  const { name, passphrase, fixtures } = providerDetails[provider];
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
          <p className="muted"><strong>Not ready for remote testing.</strong> Local fixture coverage is listed below.</p>
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
            <div className={styles.actions}>
              <button type="button">Save credentials</button>
              <button type="button" className="button-secondary">Disable credential</button>
              <button type="button" className="button-secondary">Remove credential</button>
            </div>
          </fieldset>
        </section>

        <section className="card" aria-labelledby="demo-approvals-heading">
          <h2 id="demo-approvals-heading">{name} approvals</h2>
          <ol className={styles.approvals}>
            <li>Credential setup requires dedicated {environment} credentials and verified Staging encryption and schema.</li>
            <li>Connection testing requires separate approval for this provider’s authenticated reads.</li>
            <li>Approve one {environment} order after verifying account mode, instrument precision, protection and reconciliation.</li>
            <li>Automatic execution requires a separate approval covering the account, strategy, instruments, risk limits, execution window and stop conditions.</li>
          </ol>
          <p id="demo-execution-reason" className="muted">
            This review has no verified session. Remote connection checks and execution are disabled.
          </p>
          <div className={styles.actions} aria-describedby="demo-execution-reason">
            <button type="button" disabled>Test connection</button>
            <button type="button" disabled>Start test</button>
            <button type="button" disabled>Emergency stop</button>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="demo-order-heading">
        <h2 id="demo-order-heading">Demo order preparation</h2>
        <p id="demo-order-reason" className="muted">
          Blocked pending verified instrument limits, risk controls, and approval for an individual {environment} test.
        </p>
        <fieldset disabled className={styles.credentialFields} aria-describedby="demo-order-reason">
          <legend className={styles.visuallyHidden}>{name} order details</legend>
          <label className={styles.field}>Futures instrument<select defaultValue=""><option value="">No verified instruments</option></select></label>
          <label className={styles.field}>Order side<select defaultValue=""><option value="">Select a side</option><option>Buy</option><option>Sell</option></select></label>
          <label className={styles.field}>Quantity<input inputMode="decimal" /></label>
          <label className={styles.field}>Maximum exposure<input inputMode="decimal" /></label>
          <label className={styles.field}>Stop-loss price<input inputMode="decimal" /></label>
          <label className={styles.field}>Take-profit 1 price<input inputMode="decimal" /></label>
          <label className={styles.field}>Take-profit 2 price<input inputMode="decimal" /></label>
          <label className={styles.field}>Take-profit 3 price<input inputMode="decimal" /></label>
          <button type="button">Prepare test order</button>
        </fieldset>
      </section>

      <section className={`card ${styles.automatic}`} aria-labelledby="demo-automation-heading">
        <div className={styles.automaticHeader}>
          <h2 id="demo-automation-heading">Admin Demo auto-trading</h2>
          <strong className={styles.badge}>Execution off</strong>
        </div>
        <p id="demo-automation-reason" className="muted">
          {name} {environment} requires a verified account, a successful individual lifecycle test and an approved execution window.
          Customer and real-money execution are disabled in this lab.
        </p>
        <fieldset key={provider} disabled className={styles.credentialFields} aria-describedby="demo-automation-reason">
          <legend className={styles.visuallyHidden}>{name} automatic execution configuration</legend>
          <div className={styles.automaticFields}>
            <label className={styles.field}>Demo account<select defaultValue=""><option value="">No verified account</option></select></label>
            <label className={styles.field}>Strategy<select defaultValue=""><option value="">Select an approved strategy</option><option>Standard</option><option>High-Risk</option></select></label>
            <label className={styles.field}>Risk per trade<input value="1%" readOnly /></label>
            <label className={styles.field}>Maximum orders<input inputMode="numeric" /></label>
            <label className={styles.field}>Maximum concurrent positions<input inputMode="numeric" /></label>
            <label className={styles.field}>Maximum notional exposure<input inputMode="decimal" /></label>
            <label className={styles.field}>Daily loss limit<input inputMode="decimal" /></label>
            <label className={styles.field}>Execution stop time (UTC)<input type="datetime-local" /></label>
          </div>
          <div className={styles.actions}>
            <button type="button">Start automatic Demo execution</button>
            <button type="button" className="button-secondary">Stop automatic Demo execution</button>
            <button type="button" className="button-secondary">Emergency kill switch</button>
          </div>
        </fieldset>
        <dl className={styles.evidence}>
          <div><dt>Open positions</dt><dd>No approved position snapshot.</dd></div>
          <div><dt>Order history</dt><dd>No approved account history.</dd></div>
          <div><dt>Error monitoring</dt><dd>No execution session to monitor.</dd></div>
        </dl>
      </section>

      <section className="card" aria-labelledby="demo-capabilities-heading">
        <h2 id="demo-capabilities-heading">Capability matrix</h2>
        <dl className={styles.capabilities}>
          <div><dt>Connection</dt><dd>Not configured in this review</dd></div>
          <div><dt>Staging schema</dt><dd>Schema blocked pending migration and access verification</dd></div>
          <div><dt>Credential storage</dt><dd>Credentials blocked pending encrypted storage verification</dd></div>
          <div><dt>Mock ready</dt><dd>{fixtures}</dd></div>
          <div><dt>Signed read verification</dt><dd>Awaiting an approved remote check</dd></div>
          <div><dt>Last successful connection</dt><dd>No verified timestamp</dd></div>
          <div><dt>Account permissions</dt><dd>Awaiting Demo account permission verification</dd></div>
          <div><dt>Demo execution verification</dt><dd>Awaiting verified risk controls and individual execution approval</dd></div>
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
