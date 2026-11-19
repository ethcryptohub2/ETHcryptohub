'use client';
import { useState, type FormEvent } from 'react';
import { addWatchSymbol } from '../../lib/intelligence/watchlist';

/** Keyed by authenticated account at the server boundary; never shared storage. */
export function TemporaryWatchlist() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState('');
  function add(event: FormEvent) {
    event.preventDefault();
    try { setSymbols(addWatchSymbol(symbols, symbol)); setSymbol(''); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Symbol unavailable.'); }
  }
  return <article className="card stack"><h2>Your temporary watchlist</h2>
    <p className="muted">This page-only list is not saved. No prices or momentum claims are shown while the worker is inactive.</p>
    <form className="stack" onSubmit={add}><label>Futures symbol<input value={symbol} onChange={event => setSymbol(event.target.value)} placeholder="BTCUSDT" maxLength={40} required /></label><button type="submit">Add to watchlist</button></form>
    {error && <p role="alert" className="error">{error}</p>}
    {symbols.length ? <ul>{symbols.map(item => <li key={item}>{item} · feed unavailable <button type="button" onClick={() => setSymbols(previous => previous.filter(value => value !== item))} aria-label={`Remove ${item}`}>Remove</button></li>)}</ul> : <p>No symbols selected.</p>}
  </article>;
}
