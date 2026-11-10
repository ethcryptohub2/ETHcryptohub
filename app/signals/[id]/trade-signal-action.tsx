'use client';

import { useEffect, useState } from 'react';

type Preview = {
  environment: 'DEMO' | 'LIVE';
  symbol: string;
  side: 'LONG' | 'SHORT';
  referenceEntryPrice: string;
  currentMarkPrice: string;
  quantity: string;
  notionalUsdt: string;
  leverage: number;
  stopLoss: string;
  takeProfit: string;
  executionMode: 'CONFIRM' | 'AUTOMATIC';
  canExecute: boolean;
};

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function TradeSignalAction({ signalId }: { signalId: string }) {
  const [environment, setEnvironment] = useState<'DEMO' | 'LIVE'>('DEMO');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/settings', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: { active_environment: 'DEMO' | 'LIVE' }; error?: string };
        if (!response.ok || !body.data) throw new Error(body.error ?? 'Trading environment unavailable.');
        if (active) setEnvironment(body.data.active_environment);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Trading environment unavailable.');
      });
    return () => { active = false; };
  }, []);

  async function loadPreview() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ signalId, environment }),
        cache: 'no-store',
      });
      const body = await response.json() as { data?: Preview; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Order preview unavailable.');
      setPreview(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Order preview unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!preview || !preview.canExecute) return;
    const confirmed = window.confirm(
      `${preview.environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}\n\nSubmit a ${preview.side} MARKET order for ${preview.quantity} ${preview.symbol} (about ${preview.notionalUsdt} USDT at ${preview.leverage}x)? The final fill may differ from the reference price. A stop and take-profit will be submitted after the fill. Continue?`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/trading/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          signalId,
          environment: preview.environment,
          confirm: true,
          expected: {
            environment: preview.environment,
            referenceEntryPrice: preview.referenceEntryPrice,
            currentMarkPrice: preview.currentMarkPrice,
            quantity: preview.quantity,
            notionalUsdt: preview.notionalUsdt,
            leverage: preview.leverage,
            stopLoss: preview.stopLoss,
            takeProfit: preview.takeProfit,
          },
        }),
        cache: 'no-store',
      });
      const body = await response.json() as { data?: { status: string }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Trade execution failed.');
      if (body.data.status === 'PROTECTED') {
        setMessage('Entry and protective orders are recorded. Verify the fill and open algo orders in Binance Futures.');
      } else {
        setError(`Execution status ${body.data.status}. Check Binance Futures positions and execution history immediately.`);
      }
      setPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Trade execution failed.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="card stack">
    <div><h2>Trade this signal</h2>
      <p className="mono">{environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
      <p className="muted">Preview uses the active environment balance, credentials, sizing, risk and leverage. The order is not sent until you review and confirm.</p>
    </div>
    {!preview && <button type="button" disabled={busy} onClick={() => void loadPreview()}>{busy ? 'Loading preview…' : 'Preview Futures order'}</button>}
    {preview && <div className="stack">
      <div className="signal-detail-grid">
        <div><span>Order</span><strong>{preview.side} · {preview.quantity} {preview.symbol}</strong></div>
        <div><span>Environment</span><strong>{preview.environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</strong></div>
        <div><span>Approx. notional</span><strong>{preview.notionalUsdt} USDT</strong></div>
        <div><span>Leverage</span><strong>{preview.leverage}x</strong></div>
        <div><span>Signal reference entry</span><strong>{preview.referenceEntryPrice}</strong></div>
        <div><span>Current mark price</span><strong>{preview.currentMarkPrice}</strong></div>
        <div><span>Stop Loss trigger</span><strong>{preview.stopLoss}</strong></div>
        <div><span>Take Profit trigger</span><strong>{preview.takeProfit}</strong></div>
      </div>
      <p className="scanner-warning">This is a MARKET order: the execution price can differ from the signal reference. Confirm only after checking the live Binance Futures price and account.</p>
      {!preview.canExecute && <p className="muted">Order placement is currently locked by the deployment safety gate or account settings.</p>}
      <div className="links">
        <button type="button" disabled={busy || !preview.canExecute} onClick={() => void execute()}>{busy ? 'Submitting…' : 'Confirm and place order'}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
      </div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="success" role="status">{message}</p>}
  </section>;
}
