'use client';

import { useCallback, useEffect, useState } from 'react';

type Plan = { id: string; plan_key: string; plan_name: string; duration_days: number; price_usd: string };
type Subscription = {
  id: string;
  status: 'FREE_TRIAL' | 'PREMIUM_ACTIVE' | 'TRIAL_EXPIRED' | 'PREMIUM_EXPIRED';
  hasPremiumAccess: boolean;
  planId: string | null;
  planName: string | null;
  trialStartedAt: string;
  trialExpiresAt: string;
  premiumStartedAt: string | null;
  premiumExpiresAt: string | null;
  serverNow: string;
};
type History = {
  transactions: Array<{
    id: string; amount: string; currency: string; payment_status: string;
    transaction_type: string; previous_expiry: string | null; new_expiry: string | null;
    created_at: string; plan_name: string | null; duration_days: number | null;
  }>;
  events: Array<{ id: string; event_type: string; created_at: string; plan_name: string | null }>;
};

function remaining(expiresAt: string, serverNow: string, tick: number) {
  const end = Date.parse(expiresAt);
  const server = Date.parse(serverNow);
  if (!Number.isFinite(end) || !Number.isFinite(server)) return '—';
  const seconds = Math.max(0, Math.floor((end - server - tick) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : `${hours}h ${minutes}m ${remainder}s`;
}

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function SubscriptionPanel({ paywall = false }: { paywall?: boolean }) {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [activationCode, setActivationCode] = useState('');
  const [codeVisible, setCodeVisible] = useState(false);
  const [supportEmail, setSupportEmail] = useState('');
  const [paymentPlan, setPaymentPlan] = useState<Plan | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [subscriptionResponse, historyResponse] = await Promise.all([
      fetch('/api/subscription', { cache: 'no-store' }),
      fetch('/api/subscription/history', { cache: 'no-store' }),
    ]);
    const body = await subscriptionResponse.json() as {
      data?: { subscription: Subscription; plans: Plan[]; supportEmail?: string };
      error?: string;
    };
    if (!subscriptionResponse.ok || !body.data) throw new Error(body.error ?? 'Subscription status is unavailable.');
    setSubscription(body.data.subscription);
    setPlans(body.data.plans);
    setSupportEmail(body.data.supportEmail ?? '');
    if (historyResponse.ok) {
      const historyBody = await historyResponse.json() as { data?: History };
      if (historyBody.data) setHistory(historyBody.data);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Subscription status is unavailable.'),
      );
    }, 0);
    const refresh = window.setInterval(() => {
      setTick((value) => value + 1000);
    }, 1000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(refresh);
    };
  }, [load]);

  async function activate() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrfBody = await csrfResponse.json() as { data?: { csrfToken: string } };
      const csrf = csrfBody.data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure account session unavailable.');
      const response = await fetch('/api/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ code: activationCode }),
      });
      const body = await response.json() as { data?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Activation code could not be redeemed.');
      setActivationCode('');
      setNotice('Premium access activated successfully.');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Activation code could not be redeemed.');
    } finally {
      setBusy(false);
    }
  }

  const isLocked = paywall || (subscription !== null && !subscription.hasPremiumAccess);
  const expiration = subscription?.status === 'PREMIUM_ACTIVE'
    ? subscription.premiumExpiresAt
    : subscription?.trialExpiresAt ?? null;
  const planHref = (plan: Plan) => {
    const subject = encodeURIComponent(`Manual payment instructions — ${plan.plan_name}`);
    const body = encodeURIComponent(`Hello,\n\nI would like to purchase ${plan.plan_name} (${plan.duration_days} days, $${Number(plan.price_usd).toFixed(2)} USD).\n\nAccount email:`);
    return `mailto:${encodeURIComponent(supportEmail)}?subject=${subject}&body=${body}`;
  };

  return <section className={`card stack subscription-panel${isLocked ? ' is-locked' : ''}`}>
    {isLocked ? <>
      <p className="mono">SUBSCRIPTION REQUIRED</p>
      <h2>{subscription?.status === 'PREMIUM_EXPIRED' ? 'Your Premium Subscription Has Expired' : 'Your Free Trial Has Expired'}</h2>
      <p className="muted">Subscribe to Premium to unlock Smart Signals, Live Market Research, Technical Analysis and Trading Alerts. Manual payment verification is required; clicking a plan does not process a payment.</p>
      <div className="subscription-plan-grid">{plans.map((plan) => <article key={plan.id}>
        <p className="mono">{plan.plan_name}</p><strong>${Number(plan.price_usd).toFixed(2)} <small>USD</small></strong>
        <span>{plan.duration_days} days access</span>
        <button type="button" onClick={() => setPaymentPlan(plan)}>Subscribe Now</button>
      </article>)}</div>
      {paymentPlan && <div className="subscription-payment-instructions" role="status">
        <strong>{paymentPlan.plan_name} · ${Number(paymentPlan.price_usd).toFixed(2)} USD</strong>
        <p className="muted">Contact the administrator for payment instructions. Premium is activated only after an administrator independently verifies payment and issues a single-use code.</p>
        {supportEmail ? <a className="button" href={planHref(paymentPlan)}>Email administrator</a> : <p className="muted">Ask an administrator for payment instructions through your usual support channel.</p>}
      </div>}
    </> : <>
      <p className="mono">ACCOUNT SUBSCRIPTION</p>
      <div className="subscription-status-heading">
        <h2>{subscription?.status === 'PREMIUM_ACTIVE' ? 'Premium Active' : 'Free Trial'}</h2>
        <span className={`subscription-badge ${subscription?.status === 'PREMIUM_ACTIVE' ? 'is-premium' : 'is-trial'}`}>
          {subscription?.status === 'PREMIUM_ACTIVE' ? 'PREMIUM ACTIVE' : 'FREE TRIAL'}
        </span>
      </div>
      {subscription ? <div className="subscription-facts">
        {subscription.status === 'PREMIUM_ACTIVE' && <p><span>Plan</span><strong>{subscription.planName ?? 'Premium'}</strong></p>}
        <p><span>Activated</span><strong>{date(subscription.status === 'PREMIUM_ACTIVE' ? subscription.premiumStartedAt : subscription.trialStartedAt)}</strong></p>
        <p><span>Expires</span><strong>{date(expiration)}</strong></p>
        <p><span>Remaining</span><strong>{expiration ? remaining(expiration, subscription.serverNow, tick) : '—'}</strong></p>
      </div> : <p className="muted">Loading subscription status…</p>}
    </>}
    {!subscription && error && <p className="error" role="alert">{error}</p>}
    {subscription && subscription.status === 'PREMIUM_EXPIRED' && <p className="muted">Previous plan: {subscription.planName ?? 'Premium'} · expired {date(subscription.premiumExpiresAt)}.</p>}
    {error && subscription && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    <div className="subscription-code-entry">
      <label htmlFor="subscription-code">{isLocked ? 'Enter Activation Code' : 'Renew or activate premium'}</label>
      <div className="subscription-code-row">
        <input id="subscription-code" type={codeVisible ? 'text' : 'password'} autoComplete="off" maxLength={40}
          value={activationCode} onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
          placeholder="SMRT-XXXX-XXXX-XXXX" />
        <button type="button" className="button-secondary" aria-label={codeVisible ? 'Hide code' : 'Show code'} onClick={() => setCodeVisible((value) => !value)}>{codeVisible ? 'Hide' : 'Show'}</button>
        <button type="button" disabled={busy || activationCode.trim().length < 10} onClick={() => void activate()}>{busy ? 'Activating…' : 'Activate Now'}</button>
      </div>
      {subscription?.status === 'FREE_TRIAL' && <p className="muted">Trial started {date(subscription.trialStartedAt)}. Your 7-day access period is server-recorded.</p>}
    </div>
    <details className="subscription-history">
      <summary>Subscription history</summary>
      {!history && <p className="muted">Loading history…</p>}
      {history?.transactions.map((entry) => <p key={entry.id}>
        <strong>{entry.plan_name ?? entry.transaction_type}</strong> · {entry.duration_days ?? '—'} days · {entry.payment_status.replaceAll('_', ' ')} · {date(entry.created_at)}
      </p>)}
      {history?.events.map((entry) => <p key={`event-${entry.id}`}>
        <strong>{entry.event_type.replaceAll('_', ' ')}</strong> · {entry.plan_name ?? 'Account'} · {date(entry.created_at)}
      </p>)}
      {history && history.transactions.length === 0 && history.events.length === 0 && <p className="muted">No subscription history yet.</p>}
    </details>
  </section>;
}
