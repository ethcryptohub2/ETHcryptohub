'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { MarketScannerResponse, ScannerCandidate } from '../../smartexit/apps/web/src/api';

export function Scanner() {
  const [data, setData] = useState<MarketScannerResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [timeframe, setTimeframe] = useState<ScannerCandidate['timeframe']>('15m');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ timeframe, minimumVolume: '10000000', limit: '1000', atrPeriod: '10', multiplier: '3', maxAgeSeconds: '1800', minimumScore: '60', quoteAsset: 'USDT' });
      const response = await fetch(`/api/scanner?${params}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json() as { data?: MarketScannerResponse; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? `Scanner request failed (${response.status}).`);
      setData(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Live scanner data is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [timeframe]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const ready = (data?.candidates ?? []).filter((item) => item.status === 'READY' && item.setup);
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/settings">Settings</Link><button onClick={() => void load()} disabled={loading}>{loading ? 'Scanning…' : 'Refresh'}</button></nav></header>
    <section className="hero"><p className="mono">BINANCE USDⓈ-M FUTURES · LIVE PUBLIC DATA</p><h1>Market scanner.</h1><p className="muted">Completed-candle technical setups. Review-only; no live orders are placed.</p></section>
    <section className="card stack">
      <div className="links"><label>Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as ScannerCandidate['timeframe'])}><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></label><span className="mono">{data ? `${ready.length} READY · ${data.status}` : 'CONNECTING'}</span><span className="mono">{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : ''}</span></div>
      {error && <div role="alert" className="error"><strong>Live scanner data unavailable</strong><br />{error}</div>}
      {!error && loading && !data && <p className="muted">Loading Binance market data…</p>}
      {data && ready.length === 0 && <p className="muted">No valid READY setups now. No trade is the correct outcome when criteria are not met.</p>}
      {ready.length > 0 && <div style={{ overflowX: 'auto' }}><table className="scan-table"><thead><tr><th>Pair</th><th>Side</th><th>Price</th><th>Score</th><th>Stop</th><th>TP1 / TP2 / TP3</th><th>Risk</th></tr></thead><tbody>{ready.map((item) => <tr key={item.symbol}><td>{item.symbol}</td><td>{item.side}</td><td>{item.price?.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td><td>{item.score.value}/100</td><td>{item.setup?.initialStop.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td><td>{item.setup?.tp1.toPrecision(6)} / {item.setup?.tp2.toPrecision(6)} / {item.setup?.tp3.toPrecision(6)}</td><td>{item.setup?.estimatedRisk.toFixed(2)} USDT</td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}
