'use client';

import { useEffect, useState } from 'react';
import type { evaluateStagingScanner } from '../../lib/staging-scanner-evaluation';

type Result = Awaited<ReturnType<typeof evaluateStagingScanner>>;
const endpoint = '/api/admin/scanner-evaluation';
const messages: Record<string, string> = {
  EVALUATION_REQUIRES_SEPARATE_APPROVAL: 'This Preview requires separate market access approval.',
  EVALUATION_BUSY: 'Another evaluation is running or the shared cooldown is active.',
  SYMBOL_NOT_ENABLED_IN_STAGING: 'At least one symbol is absent from the enabled Staging universe.',
  HIGH_RISK_5M_DISABLED: 'The saved High-Risk settings do not enable 5-minute evaluation.',
  PROVIDER_REGION_RESTRICTION: 'Binance reported a regional restriction.',
  PROVIDER_DENIED: 'Binance denied access.',
  PROVIDER_RATE_LIMIT: 'Binance rate-limited the request.',
  PROVIDER_WEIGHT_GUARD: 'Binance request-weight evidence was missing or exceeded the safety threshold.',
  PROVIDER_TIMEOUT_OR_CANCELLED: 'The public market request timed out or was cancelled.',
  STALE_OR_INVALID_TICKER: 'Binance returned stale or invalid ticker evidence.',
  STALE_OR_INSUFFICIENT_CANDLES: 'Binance did not return enough current closed candles.',
  CANDLE_INTERVAL_ROLLED_OVER: 'The candle interval changed during collection.',
  INVALID_SYMBOL_BATCH: 'Enter one to three distinct USD-M USDT symbols.',
};

export function ScannerEvaluation() {
  const [gate, setGate] = useState<'checking' | 'closed' | 'ready' | 'unavailable'>('checking');
  const [symbols, setSymbols] = useState('BTCUSDT');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Readiness unavailable');
      const body = await response.json() as { enabled?: boolean };
      setGate(body.enabled === true ? 'ready' : 'closed');
    }).catch(() => { if (!controller.signal.aborted) setGate('unavailable'); });
    return () => controller.abort();
  }, []);

  async function run() {
    if (gate !== 'ready' || running) return;
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const response = await fetch('/api/csrf', { cache: 'no-store' });
      const csrf = (await response.json() as { data?: { csrfToken?: string } }).data?.csrfToken;
      if (!response.ok || !csrf) throw new Error('Secure Admin session is unavailable.');
      const evaluation = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ symbols: symbols.toUpperCase().split(/[\s,]+/).filter(Boolean) }),
      });
      const body = await evaluation.json() as { data?: Result; error?: string; providerStatus?: number };
      if (!evaluation.ok || !body.data) {
        const code = body.error ?? '';
        const details = body.providerStatus ? ` (HTTP ${body.providerStatus})` : '';
        throw new Error((messages[code] ?? (code ? `Evaluation failed: ${code}` : 'Evaluation failed')) + details);
      }
      setResult(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Evaluation failed.');
    } finally {
      setRunning(false);
    }
  }

  return <div className="card stack">
    <h3>On-demand strategy evaluation</h3>
    <p className="muted">Evaluate Standard and High-Risk on closed 5-minute Binance candles. Results stay in this page and are not added to Signal History.</p>
    <label>Symbols, up to three<input value={symbols} maxLength={85} disabled={running} onChange={event => setSymbols(event.target.value)} /></label>
    <button type="button" disabled={gate !== 'ready' || running} onClick={() => void run()}>Evaluate both strategies</button>
    {gate === 'closed' && <p className="muted">Preview market access requires separate approval.</p>}
    {gate === 'unavailable' && <p role="alert">Evaluation readiness is unavailable.</p>}
    {running && <p role="status">Collecting and validating market data for this batch…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {result && <div role="status" className="stack">
      <p>Evaluated {result.completed} of {result.total} symbols. Started {result.startedAt}. Evaluated {result.evaluatedAt}. Ticker source time {result.quoteObservedAt}.</p>
      {result.rows.map(row => <article key={row.symbol}>
        <h4>{row.symbol}</h4><p>Closed candle {row.candleCloseAt}</p>
        <p>Standard · {row.standard.status} · {row.standard.reason}</p>
        <p>High-Risk · {row.highRisk.status} · {row.highRisk.reason}</p>
      </article>)}
    </div>}
  </div>;
}
