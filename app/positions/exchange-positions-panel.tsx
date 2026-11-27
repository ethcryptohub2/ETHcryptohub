'use client';

import { useCallback, useEffect, useState } from 'react';

type Position = {
  symbol: string;
  positionAmt: string;
  entryPrice: string | null;
  markPrice: string;
  unRealizedProfit: string;
  leverage: string | null;
  notionalUsdt?: string;
  marginUsdt?: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
  tp1?: string | null;
  tp2?: string | null;
  tp3?: string | null;
  executionStatus?: string;
  strategy?: string | null;
  direction?: 'LONG' | 'SHORT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
};

type Positions = {
  environment: 'DEMO' | 'LIVE';
  virtualFunds: boolean;
  positions: Position[];
};

function amount(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumSignificantDigits: 9 }) : '—';
}

function direction(position: Position) {
  if (position.direction) return position.direction;
  if (position.positionSide !== 'BOTH') return position.positionSide;
  return Number(position.positionAmt) > 0 ? 'LONG' : 'SHORT';
}

export function ExchangePositionsPanel() {
  const [data, setData] = useState<Positions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/trading/positions', { cache: 'no-store' });
      const body = await response.json() as { data?: Positions; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'Exchange positions are unavailable.');
      setData(body.data);
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Exchange positions are unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <section className="card stack">
    <div className="notification-center-heading">
      <div>
        <p className="mono">BINANCE FUTURES{data && (data.virtualFunds ? ' · DEMO / VIRTUAL FUNDS' : ' · LIVE / REAL FUNDS')}</p>
        <h2>Binance Open Positions</h2>
      </div>
      <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
    </div>
    <p className="muted">
      Authoritative open positions synchronized from Binance Futures with verified exchange leverage, margin and protection levels.
    </p>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && <p className="muted">Loading exchange positions…</p>}
    {!loading && !error && data?.positions.length === 0 && <p className="muted">Binance reported no open positions in this environment.</p>}
    {!!data?.positions.length && <div className="scanner-table-wrap"><table className="scan-table position-table">
      <thead>
        <tr>
          <th>Pair</th>
          <th>Side & Size</th>
          <th>Entry / Mark</th>
          <th>Leverage</th>
          <th>Notional / Margin</th>
          <th>Protection (SL / TP)</th>
          <th>Status</th>
          <th>Unrealized PnL</th>
        </tr>
      </thead>
      <tbody>{data.positions.map((position) => {
        const dir = direction(position);
        const pnl = Number(position.unRealizedProfit);
        const pnlPositive = pnl > 0;
        const pnlNegative = pnl < 0;
        return (
          <tr key={`${position.symbol}-${position.positionSide}`}>
            <td>
              <strong>{position.symbol}</strong>
              <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>
                {position.strategy === 'HIGH_RISK_SCALPING' ? 'Scalping' : 'Standard'} · {data.environment}
              </small>
            </td>
            <td>
              <span style={{
                display: 'inline-block',
                fontWeight: 700,
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 4,
                background: dir === 'LONG' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: dir === 'LONG' ? '#10b981' : '#ef4444',
                marginRight: 6,
              }}>
                {dir}
              </span>
              <span>{amount(position.positionAmt)}</span>
            </td>
            <td>
              <div>{position.entryPrice && Number(position.entryPrice) > 0 ? amount(position.entryPrice) : 'Pending fill'}</div>
              <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>
                Mark: {amount(position.markPrice)}
              </small>
            </td>
            <td>
              <strong style={{
                padding: '2px 6px',
                borderRadius: 4,
                background: 'var(--surface-raised)',
                fontSize: 12,
              }}>
                {position.leverage && Number(position.leverage) > 0 ? `${position.leverage}x` : '1x'}
              </strong>
            </td>
            <td>
              <div>${position.notionalUsdt ?? amount(Math.abs(Number(position.positionAmt) * Number(position.markPrice)).toFixed(2))} USDT</div>
              <small style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)' }}>
                Margin: ${position.marginUsdt ?? '—'} USDT
              </small>
            </td>
            <td>
              {position.stopLoss ? (
                <div>
                  <span style={{ fontSize: 11, color: '#ef4444' }}>SL: {amount(position.stopLoss)}</span>
                  {position.tp1 && (
                    <small style={{ display: 'block', fontSize: 10, color: '#10b981' }}>
                      TP: {amount(position.tp1)} {position.tp2 ? `/ ${amount(position.tp2)}` : ''}
                    </small>
                  )}
                </div>
              ) : (
                <span className="muted" style={{ fontSize: 11 }}>Active On Exchange</span>
              )}
            </td>
            <td>
              <span style={{
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 600,
                background: position.executionStatus === 'PROTECTED' ? '#f0fdf4' : 'var(--surface-raised)',
                color: position.executionStatus === 'PROTECTED' ? '#166534' : 'var(--text-secondary)',
              }}>
                {position.executionStatus ?? 'OPEN'}
              </span>
            </td>
            <td>
              <strong style={{
                color: pnlPositive ? '#10b981' : pnlNegative ? '#ef4444' : 'inherit',
                fontSize: 13,
              }}>
                {pnlPositive ? `+${amount(position.unRealizedProfit)}` : `${amount(position.unRealizedProfit)}`} USDT
              </strong>
            </td>
          </tr>
        );
      })}</tbody>
    </table></div>}
  </section>;
}
