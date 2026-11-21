'use client';

import { useState } from 'react';

type Balance = {
  environment: 'DEMO' | 'LIVE';
  virtualFunds: boolean;
  asset: 'USDT';
  walletBalance: string;
  availableBalance: string;
  crossWalletBalance: string;
  unrealizedPnl: string;
  maxWithdrawAmount: string | null;
  marginAvailable: boolean | null;
  lastUpdatedAt: string | null;
  synchronizedAt: string;
};

function amount(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : 'Unavailable';
}

export function FuturesBalanceCard({ signedReadEnabled }: { signedReadEnabled: boolean }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    if (!signedReadEnabled || refreshing) return;
    setRefreshing(true);
    setError('');
    try {
      const response = await fetch('/api/binance/futures/balance', { cache: 'no-store' });
      const body = await response.json() as { data?: Balance; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Futures balance is unavailable.');
      setBalance(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Futures balance is unavailable.');
    } finally {
      setRefreshing(false);
    }
  }

  return <section className="card stack">
    <div className="notification-center-heading">
      <div><p className="mono">BINANCE USDⓈ-M FUTURES</p><h2>Account balance</h2></div>
      <button type="button" className="button-secondary" disabled={!signedReadEnabled || refreshing} onClick={() => void load()} aria-label="Refresh Futures balance">
        {refreshing ? 'Refreshing…' : '↻ Refresh'}
      </button>
    </div>
    {balance && <p className="mono">{balance.virtualFunds ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>}
    {refreshing && !balance && <div className="futures-balance-skeleton" aria-label="Loading Futures balance"><span /><span /><span /><span /></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {balance && <div className="notification-details futures-balance-grid">
      <span>Total wallet balance<strong>{amount(balance.walletBalance)} USDT</strong></span>
      <span>Available balance<strong>{amount(balance.availableBalance)} USDT</strong></span>
      <span>Cross wallet balance<strong>{amount(balance.crossWalletBalance)} USDT</strong></span>
      <span>Unrealized PnL<strong>{amount(balance.unrealizedPnl)} USDT</strong></span>
      {balance.maxWithdrawAmount !== null && <span>Maximum withdrawable<strong>{amount(balance.maxWithdrawAmount)} USDT</strong></span>}
      {balance.marginAvailable !== null && <span>Margin available<strong>{balance.marginAvailable ? 'Yes' : 'No'}</strong></span>}
      <small className="muted">Last successful check {new Date(balance.synchronizedAt).toLocaleString()} · read-only snapshot</small>
    </div>}
    {!signedReadEnabled
      ? <p className="muted">Binance balance checks require separate approval.</p>
      : !refreshing && !balance && !error && <p className="muted">Select Refresh to request a balance snapshot.</p>}
  </section>;
}
