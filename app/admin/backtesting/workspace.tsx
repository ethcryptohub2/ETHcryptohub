'use client';

import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { evaluateHistoricalSignal } from '../../../lib/backtesting-engine';

const price = z.number().finite().positive();
const timestamp = z.number().int().positive().max(8_640_000_000_000_000);
const strategy = z.enum(['STANDARD', 'HIGH_RISK']);
const symbol = z.string().regex(/^[A-Z0-9]{2,24}USDT$/);
const candle = z.strictObject({
  openTime: timestamp, closeTime: timestamp, open: price, high: price, low: price, close: price,
});
const signal = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), strategy, side: z.enum(['LONG', 'SHORT']),
  generatedAt: timestamp, entryExpiresAt: timestamp, expiresAt: timestamp, candleIntervalMs: z.number().int().positive(),
  entryPrice: price, entryZoneLow: price, entryZoneHigh: price, stop: price, tp1: price, tp2: price, tp3: price,
});
const dataset = z.strictObject({
  source: z.enum(['SYNTHETIC', 'OPERATOR_SUPPLIED']),
  coverageNote: z.string().trim().min(1).max(300),
  entries: z.array(z.strictObject({ symbol, signal, candles: z.array(candle).min(1).max(5_000) })).min(1).max(100),
});
type Strategy = z.infer<typeof strategy>;
type ReplayReport = {
  source: z.infer<typeof dataset>['source'];
  coverageNote: string;
  strategy: Strategy;
  from: string;
  through: string;
  rows: { symbol: string; signalId: string; result: ReturnType<typeof evaluateHistoricalSignal> }[];
};
const maxFileBytes = 2 * 1024 * 1024;

export function BacktestWorkspace() {
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setReport(null);
    setError('');
    setBusy(true);
    try {
      const file = form.get('dataset');
      if (!(file instanceof File) || file.size === 0 || file.size > maxFileBytes) throw new Error('Choose a JSON dataset up to 2 MiB.');
      const selected = strategy.parse(form.get('strategy'));
      const from = String(form.get('from'));
      const through = String(form.get('through'));
      const start = Date.parse(from + 'T00:00:00Z');
      const end = Date.parse(through + 'T23:59:59.999Z');
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Select a valid UTC date range.');
      const requestedSymbol = String(form.get('symbol')).trim().toUpperCase();
      if (requestedSymbol && !symbol.safeParse(requestedSymbol).success) throw new Error('Enter a USDT futures symbol such as BTCUSDT.');
      const parsed = dataset.safeParse(JSON.parse(await file.text()) as unknown);
      if (!parsed.success) throw new Error('Dataset does not match the signal and candle format.');
      const { source, coverageNote, entries } = parsed.data;
      const keys = new Set<string>();
      const rows: ReplayReport['rows'] = [];
      for (const entry of entries) {
        if (entry.signal.strategy !== selected || entry.signal.generatedAt < start || entry.signal.generatedAt > end ||
          (requestedSymbol && requestedSymbol !== entry.symbol)) continue;
        const key = JSON.stringify([entry.symbol, entry.signal.side, entry.signal.generatedAt]);
        if (keys.has(key)) throw new Error('Duplicate signal in the selected dataset.');
        keys.add(key);
        rows.push({ symbol: entry.symbol, signalId: entry.signal.id, result: evaluateHistoricalSignal(entry.signal, entry.candles, end + 1) });
      }
      if (!rows.length) throw new Error('No signals match this strategy, symbol, and date range.');
      setReport({ source, coverageNote, strategy: selected, from, through, rows });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Replay failed.');
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'smartexit-candle-replay.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return <section className="card stack">
    <h2>Historical signal replay</h2>
    <p className="muted">This replays signal levels supplied in the file. Signal generation and exchange fills require separate validation. The research model closes the position at TP3 and requires explicit TP3 levels for both strategies.</p>
    <form className="stack" onSubmit={run}>
      <label>Dataset JSON<input type="file" name="dataset" accept=".json,application/json" required /></label>
      <details><summary>Dataset format</summary><p>Use source SYNTHETIC or OPERATOR_SUPPLIED, a coverageNote, and entries containing symbol, signal, and candles. Signal fields are id, strategy, side, generatedAt, entryExpiresAt, expiresAt, candleIntervalMs, entryPrice, entryZoneLow, entryZoneHigh, stop, tp1, tp2, and tp3. Candles use openTime, closeTime, open, high, low, and close. Times are UTC epoch milliseconds.</p></details>
      <label>Strategy<select name="strategy"><option value="STANDARD">Standard</option><option value="HIGH_RISK">High-Risk</option></select></label>
      <label>Symbol<input name="symbol" placeholder="All supplied symbols" maxLength={28} /></label>
      <label>From (UTC)<input type="date" name="from" required /></label>
      <label>Through (UTC)<input type="date" name="through" required /></label>
      <button disabled={busy}>{busy ? 'Replaying…' : 'Run candle replay'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {report && <div className="stack" aria-live="polite">
      <p>{report.source === 'SYNTHETIC' ? 'Synthetic dataset' : 'Operator-supplied dataset · provenance unverified'} · {report.rows.length} signals</p>
      <p>{report.coverageNote}</p>
      <p>Returns are gross and simulated. Fees, slippage and funding are excluded.</p>
      <button type="button" onClick={download}>Download replay report</button>
      {report.rows.map((row, index) => <details key={index}>
        <summary>{row.symbol} · {row.signalId} · {row.result.status.replaceAll('_', ' ')}</summary>
        {row.result.reason && <p>{row.result.reason}</p>}
        {row.result.grossReturnPercent !== null && <p>Gross return {row.result.grossReturnPercent.toFixed(2)}%</p>}
        <ul>{row.result.events.map((event, index) => <li key={index}>
          {event.type.replaceAll('_', ' ')} · {new Date(event.observedAt).toISOString()} · {event.price}
        </li>)}</ul>
      </details>)}
    </div>}
  </section>;
}
