'use client';

import { useCallback, useEffect, useState } from 'react';

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

export function FuturesBalanceCard() {
  const [environment, setEnvironment] = useState<'DEMO' | 'LIVE'>('DEMO');
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/binance/futures/balance', { cache: 'no-store' });
      const body = await response.json() as { data?: Balance; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Futures balance is unavailable.');
      setBalance(body.data);
      setEnvironment(body.data.environment);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Futures balance is unavailable.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/trading/settings', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { data?: { active_environment: 'DEMO' | 'LIVE' } };
        if (response.ok && body.data && active) setEnvironment(body.data.active_environment);
      })
      .catch(() => {
        if (active) setError('Could not load the active trading environment.');
      });
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(true), 60_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  return <section className="card stack">
    <div className="notification-center-heading">
      <div><p className="mono">BINANCE USDⓈ-M FUTURES</p><h2>Account balance</h2></div>
      <button type="button" className="button-secondary" disabled={refreshing} onClick={() => void load(true)} aria-label="Refresh Futures balance">
        {refreshing ? 'Refreshing…' : '↻ Refresh'}
      </button>
    </div>
    <p className="mono">{environment === 'DEMO' ? 'DEMO / VIRTUAL FUNDS' : 'LIVE / REAL FUNDS'}</p>
    {loading && <div className="futures-balance-skeleton" aria-label="Loading Futures balance"><span /><span /><span /><span /></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {balance && <div className="notification-details futures-balance-grid">
      <span>Total wallet balance<strong>{amount(balance.walletBalance)} USDT</strong></span>
      <span>Available balance<strong>{amount(balance.availableBalance)} USDT</strong></span>
      <span>Cross wallet balance<strong>{amount(balance.crossWalletBalance)} USDT</strong></span>
      <span>Unrealized PnL<strong>{amount(balance.unrealizedPnl)} USDT</strong></span>
      {balance.maxWithdrawAmount !== null && <span>Maximum withdrawable<strong>{amount(balance.maxWithdrawAmount)} USDT</strong></span>}
      {balance.marginAvailable !== null && <span>Margin available<strong>{balance.marginAvailable ? 'Yes' : 'No'}</strong></span>}
      <small className="muted">Synced {new Date(balance.synchronizedAt).toLocaleString()} · read-only</small>
    </div>}
    {!loading && !balance && !error && <p className="muted">No balance information is available.</p>}
  </section>;
}
