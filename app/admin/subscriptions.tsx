'use client';

import { useCallback, useEffect, useState } from 'react';
import { TABLE_PAGE_SIZE } from '../../lib/pagination';
import { TablePagination } from './table-pagination';

type Plan = {
  id: string; plan_key: string; plan_name: string; duration_days: number; price_usd: string; is_active: boolean;
};
type UserSubscription = {
  id: number; email: string; subscription_status: string; trial_started_at: string; trial_expires_at: string;
  premium_started_at: string | null; premium_expires_at: string | null; plan_name: string | null; plan_id: string | null;
};
type License = {
  id: string; plan_name: string; duration_days: number; code_status: string; assigned_user_email: string | null;
  payment_reference: string | null;
  redeemed_by_email: string | null; redeemed_at: string | null; expires_at: string | null;
  admin_note: string | null; created_at: string; created_by_email: string | null; is_expired: boolean;
};
type AdminData = {
  metrics: Record<string, string>;
  plans: Plan[];
  users: UserSubscription[];
  usersTotal: number;
  codes: License[];
  codesTotal: number;
};
type GeneratedCode = { code: string; planName: string; durationDays: number };

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function AdminSubscriptions() {
  const [data, setData] = useState<AdminData | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [codeStatus, setCodeStatus] = useState('ALL');
  const [userPage, setUserPage] = useState(1);
  const [codePage, setCodePage] = useState(1);
  const [selectedPlan, setSelectedPlan] = useState('');
  const [codeCount, setCodeCount] = useState(1);
  const [assignedEmail, setAssignedEmail] = useState('');
  const [codeExpiry, setCodeExpiry] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [note, setNote] = useState('');
  const [generated, setGenerated] = useState<GeneratedCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      search, status, codeStatus, userPage: String(userPage), codePage: String(codePage),
    });
    const response = await fetch(`/api/admin/subscriptions?${params}`, { cache: 'no-store' });
    const body = await response.json() as { data?: AdminData; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Subscription management could not be loaded.');
    const lastUserPage = Math.max(1, Math.ceil(body.data.usersTotal / TABLE_PAGE_SIZE));
    const lastCodePage = Math.max(1, Math.ceil(body.data.codesTotal / TABLE_PAGE_SIZE));
    if (userPage > lastUserPage || codePage > lastCodePage) {
      if (userPage > lastUserPage) setUserPage(lastUserPage);
      if (codePage > lastCodePage) setCodePage(lastCodePage);
      return;
    }
    setData(body.data);
    setSelectedPlan((current) => current || body.data!.plans.find((plan) => plan.plan_key !== 'FREE_TRIAL')?.id || '');
  }, [search, status, codeStatus, userPage, codePage]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Subscription data unavailable.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(payload: Record<string, unknown>, successText: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const token = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('Secure administrator session unavailable.');
      const response = await fetch('/api/admin/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { data?: { codes?: GeneratedCode[] }; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Subscription action failed.');
      if (body.data?.codes) setGenerated(body.data.codes);
      await load();
      setNotice(successText);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Subscription action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function generateCodes(event: React.FormEvent) {
    event.preventDefault();
    const plan = data?.plans.find((item) => item.id === selectedPlan);
    if (!plan) return;
    if (!window.confirm(`Confirm payment was independently verified before issuing ${codeCount} ${plan.plan_name} code(s)?`)) return;
    await mutate({
      action: 'generate_codes',
      planId: plan.id,
      count: codeCount,
      assignedEmail: assignedEmail.trim() || undefined,
      expiresAt: codeExpiry ? new Date(codeExpiry).toISOString() : null,
      note: note.trim() || null,
      manualPaymentVerified: true,
      paymentReference: paymentReference.trim(),
    }, 'License codes generated. Save them now; full codes are not shown again.');
  }

  async function savePlans(event: React.FormEvent) {
    event.preventDefault();
    if (!data) return;
    await mutate({
      action: 'update_plans',
      plans: data.plans.filter((plan) => plan.plan_key !== 'FREE_TRIAL').map((plan) => ({
        id: plan.id,
        planName: plan.plan_name,
        durationDays: Number(plan.duration_days),
        priceUsd: Number(plan.price_usd),
        isActive: plan.is_active,
      })),
    }, 'Premium plans updated.');
  }

  function updatePlan(id: string, field: 'plan_name' | 'duration_days' | 'price_usd' | 'is_active', value: string | boolean) {
    setData((current) => current ? ({
      ...current,
      plans: current.plans.map((plan) => plan.id === id ? { ...plan, [field]: value } : plan),
    }) : current);
  }

  const metrics = data?.metrics;

  return <section className="card stack subscription-admin" id="subscription-management">
    <p className="mono">ADMIN · BILLING & ENTITLEMENTS</p><h2>Subscription Management</h2>
    <p className="muted">Manual payment verification only. The system never treats a user click as payment confirmation and does not process recurring charges.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!data && !error && <p className="muted">Loading subscription data…</p>}
    {data && <>
      <div className="subscription-admin-metrics">
        {[
          ['Registered Users', 'total_users'], ['Free Trial', 'free_trial_users'],
          ['Premium Active', 'premium_active_users'], ['Trial Expired', 'expired_trial_users'],
          ['Premium Expired', 'expired_premium_users'], ['Generated Codes', 'total_codes'],
          ['Unused Codes', 'unused_codes'], ['Redeemed Codes', 'redeemed_codes'],
          ['Expired Codes', 'expired_codes'], ['Revoked Codes', 'revoked_codes'],
        ].map(([label, key]) => <article key={key}><span>{label}</span><strong>{metrics?.[key] ?? '0'}</strong></article>)}
      </div>

      <form className="stack subscription-admin-plans" onSubmit={(event) => void savePlans(event)}>
        <h3>Premium plan pricing and duration</h3>
        {data.plans.filter((plan) => plan.plan_key !== 'FREE_TRIAL').map((plan) => <div className="subscription-plan-edit" key={plan.id}>
          <label>Plan<input value={plan.plan_name} maxLength={80} onChange={(event) => updatePlan(plan.id, 'plan_name', event.target.value)} /></label>
          <label>Days<input type="number" min={1} max={3650} value={plan.duration_days} onChange={(event) => updatePlan(plan.id, 'duration_days', event.target.value)} /></label>
          <label>Price (USD)<input type="number" min={0} step="0.01" value={plan.price_usd} onChange={(event) => updatePlan(plan.id, 'price_usd', event.target.value)} /></label>
          <label className="subscription-check"><input type="checkbox" checked={plan.is_active} onChange={(event) => updatePlan(plan.id, 'is_active', event.target.checked)} /> Active</label>
        </div>)}
        <button type="submit" disabled={busy}>Save plan settings</button>
      </form>

      <form className="stack subscription-code-generator" onSubmit={(event) => void generateCodes(event)}>
        <h3>License Code Generator</h3>
        <div className="subscription-generator-grid">
          <label>Plan<select required value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>
            {data.plans.filter((plan) => plan.plan_key !== 'FREE_TRIAL' && plan.is_active).map((plan) => <option key={plan.id} value={plan.id}>{plan.plan_name} · {plan.duration_days} days · ${Number(plan.price_usd).toFixed(2)}</option>)}
          </select></label>
          <label>Codes<input type="number" min={1} max={100} value={codeCount} onChange={(event) => setCodeCount(Number(event.target.value))} /></label>
          <label>Assigned email (optional)<input type="email" maxLength={255} value={assignedEmail} onChange={(event) => setAssignedEmail(event.target.value)} /></label>
          <label>Code expiry (optional)<input type="datetime-local" value={codeExpiry} onChange={(event) => setCodeExpiry(event.target.value)} /></label>
          <label>Manual payment reference<input required maxLength={160} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Receipt or internal reference" /></label>
          <label>Internal note<input maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        </div>
        <p className="muted">Generate only after independently verifying payment. Codes are stored as keyed hashes and displayed only in this response.</p>
        <button type="submit" disabled={busy || !selectedPlan || !paymentReference.trim()}>{busy ? 'Processing…' : 'Generate Code'}</button>
      </form>

      {generated.length > 0 && <div className="subscription-generated-codes">
        <h3>Generated activation codes · copy now</h3>
        {generated.map((item) => <div key={item.code}>
          <strong>{item.code}</strong><span>{item.planName} · {item.durationDays} days</span>
          <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(item.code)}>Copy</button>
        </div>)}
      </div>}

      <div className="stack">
        <h3>User subscription management</h3>
        <div className="subscription-admin-toolbar">
          <label>Search email or user ID<input value={search} onChange={(event) => { setSearch(event.target.value); setUserPage(1); setCodePage(1); }} /></label>
          <label>Status<select value={status} onChange={(event) => { setStatus(event.target.value); setUserPage(1); }}>
            <option value="ALL">All statuses</option><option value="FREE_TRIAL">Free trial</option><option value="PREMIUM_ACTIVE">Premium active</option><option value="TRIAL_EXPIRED">Trial expired</option><option value="PREMIUM_EXPIRED">Premium expired</option>
          </select></label>
        </div>
        <div className="scanner-management-table-wrap"><table className="scanner-management-table subscription-table"><thead><tr><th>User ID</th><th>Email</th><th>Status</th><th>Plan</th><th>Started</th><th>Expires</th><th>Admin action</th></tr></thead>
          <tbody>{data.users.map((user) => <tr key={user.id}><td>{user.id}</td><td>{user.email}</td><td>{user.subscription_status.replaceAll('_', ' ')}</td><td>{user.plan_name ?? 'Free Trial'}</td>
            <td>{date(user.premium_started_at ?? user.trial_started_at)}</td><td>{date(user.premium_expires_at ?? user.trial_expires_at)}</td>
            <td><button type="button" className="button-secondary" disabled={busy} onClick={() => {
              const days = Number(window.prompt('Enter premium duration in days:', '30'));
              if (!Number.isInteger(days) || days < 1 || days > 3650) return;
              const reason = window.prompt('Reason for this complimentary grant:');
              if (!reason?.trim()) return;
              void mutate({ action: 'grant_complimentary', userId: user.id, durationDays: days, planId: null, reason: reason.trim(), paymentReference: null }, `Complimentary premium granted to ${user.email}.`);
            }}>Grant complimentary</button> <button type="button" className="button-secondary" disabled={busy} onClick={() => {
              const days = Number(window.prompt('Enter premium extension in days:', '30'));
              if (!Number.isInteger(days) || days < 1 || days > 3650) return;
              const reason = window.prompt('Reason for this extension:');
              if (!reason?.trim()) return;
              void mutate({ action: 'extend_premium', userId: user.id, durationDays: days, planId: user.plan_id ?? null, reason: reason.trim(), paymentReference: null }, `Premium extended for ${user.email}.`);
            }}>Extend</button></td>
          </tr>)}</tbody>
        </table></div>
        <TablePagination page={userPage} total={data.usersTotal} label="users" onPageChange={setUserPage} />
      </div>

      <div className="stack">
        <h3>License code management</h3>
        <label>Filter codes<select value={codeStatus} onChange={(event) => { setCodeStatus(event.target.value); setCodePage(1); }}>
          <option value="ALL">All codes</option><option value="UNUSED">Unused</option><option value="REDEEMED">Redeemed</option><option value="EXPIRED">Expired</option><option value="REVOKED">Revoked</option>
        </select></label>
        <div className="scanner-management-table-wrap"><table className="scanner-management-table subscription-table"><thead><tr><th>Code</th><th>Plan</th><th>Status</th><th>Assigned</th><th>Redeemed by</th><th>Payment reference</th><th>Created</th><th>Redeemed</th><th>Code expiry</th><th>Action</th></tr></thead>
          <tbody>{data.codes.map((code) => <tr key={code.id}><td>SMRT-••••-••••-••••</td><td>{code.plan_name} · {code.duration_days}d</td><td>{code.is_expired ? 'EXPIRED' : code.code_status}</td><td>{code.assigned_user_email ?? '—'}</td><td>{code.redeemed_by_email ?? '—'}</td><td>{code.payment_reference ?? '—'}</td><td>{date(code.created_at)}</td><td>{date(code.redeemed_at)}</td><td>{date(code.expires_at)}</td>
            <td>{code.code_status === 'UNUSED' && !code.is_expired && <button type="button" className="button-secondary" disabled={busy} onClick={() => {
              if (window.confirm('Revoke this unused code? Redeemed codes cannot be revoked.')) {
                void mutate({ action: 'revoke_code', codeId: code.id, reason: 'Revoked by administrator.' }, 'Unused code revoked.');
              }
            }}>Revoke</button>}</td>
          </tr>)}</tbody>
        </table></div>
        <TablePagination page={codePage} total={data.codesTotal} label="codes" onPageChange={setCodePage} />
      </div>
    </>}
  </section>;
}
