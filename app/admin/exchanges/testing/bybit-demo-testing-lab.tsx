'use client';

import { useEffect, useState, type FormEvent } from 'react';

type LabState = {
  credentialStatus: {
    configured: boolean;
    environmentConfirmationRequired?: boolean;
    maskedApiKey: string | null;
    lastVerifiedAt: string | null;
    updatedAt: string | null;
  };
  emergencyStop: boolean;
  orderSubmissionEnabled: boolean;
  events: Array<{
    id: string;
    event_type: string;
    status: string;
    symbol: string | null;
    exchange_order_id: string | null;
    client_order_id: string | null;
    created_at: string;
    error_message: string | null;
  }>;
};

async function loadLab() {
  const response = await fetch('/api/admin/exchanges/testing', { cache: 'no-store' });
  const body = await response.json() as { data?: LabState; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error ?? 'Bybit Demo lab is unavailable.');
  return body.data;
}

async function getCsrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function BybitDemoTestingLab() {
  const [state, setState] = useState<LabState | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [quantity, setQuantity] = useState('0.001');
  const [price, setPrice] = useState('');
  const [leverage, setLeverage] = useState('1');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [orderId, setOrderId] = useState('');
  const [clientOrderId, setClientOrderId] = useState('');
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void loadLab()
      .then((data) => { if (active) setState(data); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Bybit Demo lab is unavailable.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function perform(payload: Record<string, unknown>, confirmation?: string): Promise<boolean> {
    if (confirmation && !window.confirm(confirmation)) return false;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const csrfToken = await getCsrfToken();
      const response = await fetch('/api/admin/exchanges/testing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { data?: unknown; error?: string; clientOrderId?: string };
      if (body.clientOrderId) setClientOrderId(body.clientOrderId);
      if (
        body.data &&
        typeof body.data === 'object' &&
        'clientOrderId' in body.data &&
        typeof body.data.clientOrderId === 'string'
      ) setClientOrderId(body.data.clientOrderId);
      if (!response.ok) throw new Error(body.error ?? 'Bybit Demo request failed.');
      setResult(body.data ?? null);
      setMessage('Bybit Demo request completed. Review the exchange response and Demo account before the next test.');
      setState(await loadLab());
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Bybit Demo request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveCredentials(event: FormEvent) {
    event.preventDefault();
    if (await perform({ action: 'saveCredentials', apiKey, apiSecret })) {
      setApiKey('');
      setApiSecret('');
    }
  }

  if (loading) return <section className="card"><p className="muted">Loading Bybit Demo testing lab…</p></section>;

  return <section className="stack">
    <article className="card stack">
      <p className="mono">BYBIT · DEMO / VIRTUAL FUNDS · FIXED API ENDPOINT</p>
      <h2>Admin credentials</h2>
      <p className="muted">
        This lab only uses the signed-in administrator’s Bybit Demo key at the fixed Demo API endpoint. Use a Demo key, one-way position mode, and API permissions limited to reading and futures trading. Withdrawals/transfers must remain disabled.
      </p>
      <p className="muted">
        {state?.credentialStatus.configured
          ? `Configured ${state.credentialStatus.maskedApiKey ?? ''} · saved ${state.credentialStatus.updatedAt ? new Date(state.credentialStatus.updatedAt).toLocaleString() : '—'} · last connection test ${state.credentialStatus.lastVerifiedAt ? new Date(state.credentialStatus.lastVerifiedAt).toLocaleString() : 'not tested'}`
          : state?.credentialStatus.environmentConfirmationRequired
            ? 'A legacy credential exists but its original environment is unverified. Re-enter a dedicated Bybit Demo key before testing.'
            : 'No Bybit Demo credentials are stored for this administrator.'}
      </p>
      <form className="notification-control-grid" onSubmit={(event) => void saveCredentials(event)}>
        <label>Bybit Demo API Key<input autoComplete="off" value={apiKey} minLength={8} maxLength={256} onChange={(event) => setApiKey(event.target.value)} required /></label>
        <label>Bybit Demo API Secret<input type="password" autoComplete="new-password" value={apiSecret} minLength={8} maxLength={512} onChange={(event) => setApiSecret(event.target.value)} required /></label>
        <div className="links">
          <button disabled={busy}>Save encrypted Demo keys</button>
          <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'removeCredentials' })}>Remove Demo keys</button>
          <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'testConnection' })}>Test Demo connection</button>
        </div>
      </form>
    </article>

    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}

    <article className="card stack">
      <p className="mono">READ-ONLY ACCOUNT AND MARKET TESTS</p>
      <div className="notification-control-grid">
        <label>USDT linear symbol<input value={symbol} maxLength={30} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
        <label>Order quantity<input inputMode="decimal" value={quantity} maxLength={30} onChange={(event) => setQuantity(event.target.value)} /></label>
      </div>
      <div className="links">
        <button type="button" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'balance' })}>Demo balance</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'instruments' })}>USDT instruments</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'ticker', symbol })}>Ticker</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'positions' })}>Positions</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'orders', symbol })}>Open orders</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'history', symbol })}>Order history</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'executions', symbol })}>Execution history</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'closedPnl', symbol })}>Closed PnL</button>
      </div>
    </article>

    <article className="card stack">
      <p className="mono">DEMO ORDER AND PROTECTION TESTS · {state?.orderSubmissionEnabled ? 'SERVER GATE ENABLED' : 'DISABLED'}</p>
      <p className="muted">
        {state?.orderSubmissionEnabled
          ? 'A market/limit request can create an order on the selected Bybit Demo account and still requires explicit confirmation.'
          : 'Exchange-mutating actions are blocked by a server-side feature gate until a separate Demo account approval. Read-only Demo checks remain available. Live orders are not available in this lab.'}
      </p>
      <div className="notification-control-grid">
        <label>Limit price<input inputMode="decimal" value={price} maxLength={30} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>Leverage<input type="number" min="1" max="125" step="1" value={leverage} onChange={(event) => setLeverage(event.target.value)} /></label>
        <label>Stop-loss trigger<input inputMode="decimal" value={stopLoss} maxLength={30} onChange={(event) => setStopLoss(event.target.value)} /></label>
        <label>Take-profit trigger<input inputMode="decimal" value={takeProfit} maxLength={30} onChange={(event) => setTakeProfit(event.target.value)} /></label>
        <label>Order ID to cancel<input inputMode="numeric" value={orderId} maxLength={32} onChange={(event) => setOrderId(event.target.value)} /></label>
        <label>Client order ID to reconcile<input value={clientOrderId} maxLength={36} onChange={(event) => setClientOrderId(event.target.value)} /></label>
      </div>
      <div className="links">
        <button type="button" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || state.emergencyStop} onClick={() => void perform({ action: 'marketOrder', symbol, quantity, side: 'BUY', confirmDemoOrder: true }, `Place a LONG (BUY) ${quantity} ${symbol} market order on Bybit DEMO only?`)}>Test LONG market order</button>
        <button type="button" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || state.emergencyStop} onClick={() => void perform({ action: 'marketOrder', symbol, quantity, side: 'SELL', confirmDemoOrder: true }, `Place a SHORT (SELL) ${quantity} ${symbol} market order on Bybit DEMO only?`)}>Test SHORT market order</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || state.emergencyStop || !price} onClick={() => void perform({ action: 'limitOrder', symbol, quantity, price, side: 'BUY', confirmDemoOrder: true }, `Place a BUY limit order on Bybit DEMO at ${price}?`)}>Test limit order</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || state.emergencyStop} onClick={() => void perform({ action: 'leverage', symbol, leverage: Number(leverage) }, `Set Bybit DEMO ${symbol} leverage to ${leverage}x?`)}>Set leverage</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || state.emergencyStop || !stopLoss || !takeProfit} onClick={() => void perform({ action: 'protection', symbol, stopLoss, takeProfit, confirmDemoOrder: true }, `Set both Bybit DEMO ${symbol} position TP and SL to ${takeProfit} / ${stopLoss}?`)}>Set position TP/SL</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured || !orderId} onClick={() => void perform({ action: 'cancel', symbol, orderId, confirmDemoOrder: true }, `Cancel Bybit DEMO order ${orderId}?`)}>Cancel order</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.credentialStatus.configured || !clientOrderId} onClick={() => void perform({ action: 'reconcile', symbol, clientOrderId })}>Reconcile client order ID</button>
        <button type="button" className="button-secondary" disabled={busy || !state?.orderSubmissionEnabled || !state?.credentialStatus.configured} onClick={() => void perform({ action: 'close', symbol, confirmDemoOrder: true }, `Close the full open Bybit DEMO ${symbol} position with a reduce-only market order?`)}>Close full position</button>
      </div>
      <div className="links">
        <strong className="mono">{state?.emergencyStop ? 'DEMO EMERGENCY STOP ACTIVE' : 'DEMO EMERGENCY STOP OFF'}</strong>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void perform(
            { action: 'emergencyStop', enabled: !state?.emergencyStop },
            state?.emergencyStop ? 'Disable the Bybit Demo testing emergency stop? This affects Demo testing only.' : 'Enable the Bybit Demo testing emergency stop? New Demo test orders will be blocked.',
          )}
        >
          {state?.emergencyStop ? 'Reset Demo stop' : 'Enable Demo stop'}
        </button>
      </div>
    </article>

    {result !== null && <article className="card stack"><p className="mono">LAST API RESULT · BYBIT DEMO</p><pre className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result, null, 2)}</pre></article>}

    <article className="card stack">
      <p className="mono">RECENT ADMIN DEMO TEST EVENTS</p>
      {!state?.events.length && <p className="muted">No Demo test events have been recorded.</p>}
      {state?.events.map((event) => <p className="muted" key={event.id}>
        {new Date(event.created_at).toLocaleString()} · {event.event_type} · {event.status} · {event.symbol ?? '—'}
        {event.exchange_order_id ? ` · order ${event.exchange_order_id}` : ''}
        {event.client_order_id ? ` · client ${event.client_order_id}` : ''}
        {event.error_message ? ` · ${event.error_message}` : ''}
      </p>)}
    </article>
  </section>;
}
