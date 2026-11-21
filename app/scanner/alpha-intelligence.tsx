'use client';

import { useEffect, useState } from 'react';
import type { AlphaObservation, AlphaSnapshot } from '../../lib/alpha-intelligence';
import type { ArchivedAlphaObservation } from '../../lib/alpha-observation-history';
import styles from './alpha-intelligence.module.css';

type SortMode = 'symbol' | 'volume' | 'momentum' | 'updated';

const rankField = {
  volume: 'volumeChangePercent',
  momentum: 'momentumPercent',
  updated: 'verifiedAt',
} as const;

const sourceStatus = {
  DISABLED: 'Disabled',
  AVAILABLE: 'Available',
  UNAVAILABLE: 'Unavailable',
} as const;

const unavailable = 'Unavailable';
const decimal = new Intl.NumberFormat('en', { maximumSignificantDigits: 7 });
const adminEndpoint = '/api/admin/alpha-intelligence';

function AlphaAdminRefresh({ onSnapshot }: { onSnapshot: (snapshot: AlphaSnapshot) => void }) {
  const [gate, setGate] = useState<'checking' | 'enabled' | 'disabled' | 'unavailable'>('checking');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const [archiveState, setArchiveState] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(adminEndpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Approval status unavailable.');
      const body = await response.json() as { enabled?: boolean; historyEnabled?: boolean };
      setGate(body.enabled === true ? 'enabled' : 'disabled');
      setHistoryEnabled(body.historyEnabled === true);
    }).catch(() => { if (!controller.signal.aborted) setGate('unavailable'); });
    return () => controller.abort();
  }, []);

  async function refresh() {
    if (gate !== 'enabled' || running) return;
    setRunning(true);
    setError('');
    setArchiveState('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const csrf = (await csrfResponse.json() as { data?: { csrfToken?: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !csrf) throw new Error('Secure Admin session is unavailable.');
      const response = await fetch(adminEndpoint, { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
      const result = await response.json() as { data?: AlphaSnapshot; archive?: string };
      if (response.status === 429) throw new Error('An Alpha check is running or the cooldown is active.');
      if (!response.ok || !result.data) throw new Error('Alpha acquisition could not complete. Check approval and source status before retrying.');
      onSnapshot(result.data);
      if (result.archive === 'STORED') setArchiveState('Approved observations saved to history.');
      if (result.archive === 'ALREADY_RECORDED') setArchiveState('These observations are already in history.');
      if (result.archive === 'UNAVAILABLE') setArchiveState('Observations loaded, but history could not be saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Alpha acquisition could not complete.');
    } finally {
      setRunning(false);
    }
  }

  return <div className="stack">
    <button type="button" className="button-secondary" disabled={gate !== 'enabled' || running}
      onClick={() => void refresh()}>{running ? 'Checking approved Alpha sources…' : 'Check approved Alpha sources'}</button>
    {gate === 'disabled' && <p className="muted">Source acquisition requires separate approval.</p>}
    {gate === 'unavailable' && <p className="muted">Approval status unavailable.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {archiveState && <p role="status">{archiveState}</p>}
    {historyEnabled && <AlphaHistory />}
  </div>;
}

function AlphaHistory() {
  const [rows, setRows] = useState<ArchivedAlphaObservation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`${adminEndpoint}?history=1`, { cache: 'no-store' });
      const body = await response.json() as { data?: ArchivedAlphaObservation[] };
      if (!response.ok || !Array.isArray(body.data)) throw new Error('History unavailable');
      setRows(body.data);
    } catch {
      setRows(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return <section className="stack" aria-label="Archived Alpha observations">
    <button type="button" className="button-secondary" disabled={loading} onClick={() => void load()}>
      {loading ? 'Loading archived observations…' : 'Load archived Alpha observations'}
    </button>
    {error && <p role="alert">Alpha observation history could not be read.</p>}
    {rows?.length === 0 && <p>No Alpha observations have been archived.</p>}
    {!!rows?.length && <ul>{rows.map(row => <li key={`${row.alpha_id}:${row.chain}:${row.contract}:${row.market}:${row.observed_at}`}>
      {row.measurements.symbol} · {row.chain} · {row.market} · Observed {timestamp(row.observed_at)}
      {' · '}Archived {timestamp(row.collected_at)} · Archived price {metric(row.measurements.price)}
    </li>)}</ul>}
  </section>;
}

function metric(value: number | null, suffix = '') {
  return value !== null && Number.isFinite(value) ? `${decimal.format(value)}${suffix}` : unavailable;
}

function timestamp(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? value.replace('T', ' ').replace(/Z$/, ' UTC') : unavailable;
}

function sortValue(row: AlphaObservation, sort: Exclude<SortMode, 'symbol'>) {
  const value = row[rankField[sort]];
  const numeric = typeof value === 'string' ? Date.parse(value) : value;
  return numeric !== null && Number.isFinite(numeric) ? numeric : -Infinity;
}

function safeSource(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function AlphaToken({ row, watched, toggleWatch }: { row: AlphaObservation; watched: boolean; toggleWatch: () => void }) {
  const fields: Array<[string, string]> = [
    ['Supported market', row.market ?? unavailable],
    ['Observed price', metric(row.price)],
    ['24-hour quote volume', metric(row.quoteVolume24h)],
    ['Volume change', metric(row.volumeChangePercent, '%')],
    ['Price momentum', metric(row.momentumPercent, '%')],
    ['Liquidity', row.liquidity === 'VERIFIED_DEPTH' ? 'Verified order-book depth' : 'Depth unavailable'],
    ['Bid depth', metric(row.bidDepthQuote)],
    ['Ask depth', metric(row.askDepthQuote)],
    ['Exchange and wallet flows', unavailable],
    ['Holder concentration', unavailable],
    ['Contract risk', 'Unverified'],
    ['Official campaign evidence', unavailable],
    ['News sentiment', unavailable],
    ['X and YouTube activity', unavailable],
    ['Engagement anomalies', unavailable],
    ['Risk score', 'Unscored'],
    ['Signal status', 'Observation only'],
    ['Last verified update', timestamp(row.verifiedAt)],
  ];
  const links = row.sourceLinks.flatMap(value => safeSource(value) ?? []);
  return <article className="card stack">
    <div className={styles.tokenHeading}>
      <div><h3>{row.symbol}</h3><p>{row.name}</p></div>
      <button type="button" className="button-secondary" aria-pressed={watched}
        aria-label={`Watch ${row.symbol}`} onClick={toggleWatch}>{watched ? 'Watching' : 'Watch'}</button>
    </div>
    <p className="muted">{row.chain} · <code className={styles.contract}>{row.contract}</code></p>
    <dl className={styles.fields}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {links.length > 0 && <ul className={styles.sources} aria-label={`Sources for ${row.symbol}`}>
      {links.map(link => <li key={link.href}><a href={link.href}>{link.hostname}{link.pathname}</a></li>)}
    </ul>}
  </article>;
}

export function AlphaIntelligence({ snapshot, watchlist, onToggleWatchlist, isAdmin, onSnapshot }: {
  snapshot: AlphaSnapshot;
  watchlist: readonly string[];
  onToggleWatchlist: (id: string) => void;
  isAdmin: boolean;
  onSnapshot: (snapshot: AlphaSnapshot) => void;
}) {
  const [search, setSearch] = useState('');
  const [chain, setChain] = useState('');
  const [watchOnly, setWatchOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>('symbol');
  const input = search.trim().toLowerCase();
  const watched = new Set(watchlist);
  const chains = [...new Set(snapshot.rows.map(row => row.chain))].sort();
  const rows = snapshot.rows
    .filter(row => (!chain || row.chain === chain) && (!watchOnly || watched.has(row.id)) &&
      (!input || [row.symbol, row.name, row.contract].some(field => field.toLowerCase().includes(input))))
    .sort((left, right) => (sort === 'symbol' ? 0 : sortValue(right, sort) - sortValue(left, sort)) ||
      left.symbol.localeCompare(right.symbol) || left.id.localeCompare(right.id));

  return <>
    <section className="hero scanner-hero">
      <h1>Binance Alpha Intelligence</h1>
      <p className="muted">Review verified market observations and source evidence. Alpha observations stay outside Futures qualification and order preparation.</p>
    </section>
    <section className="card stack" aria-labelledby="alpha-source-health">
      <h2 id="alpha-source-health">Source health</h2>
      <p className="muted">Last source check {timestamp(snapshot.checkedAt)}</p>
      {isAdmin && <AlphaAdminRefresh onSnapshot={onSnapshot} />}
      <ul className={styles.sources}>
        {snapshot.sources.map(source => {
          const link = safeSource(source.url);
          return <li key={source.id}>
            <strong>{source.label}</strong> · {sourceStatus[source.status]}
            <p>{source.detail}{source.checkedAt && ` Checked ${timestamp(source.checkedAt)}.`}</p>
            {link && <a href={link.href}>Documentation for {source.label}</a>}
          </li>;
        })}
      </ul>
    </section>
    <section className="card stack" aria-labelledby="alpha-market-heading">
      <h2 id="alpha-market-heading">Alpha markets</h2>
      <div className={styles.controls}>
        <label>Search token or contract<input type="search" value={search} maxLength={128} onChange={event => setSearch(event.target.value)} /></label>
        <label>Chain<select value={chain} onChange={event => setChain(event.target.value)}>
          <option value="">All chains</option>{chains.map(item => <option key={item}>{item}</option>)}
        </select></label>
        <label>Sort by<select value={sort} onChange={event => setSort(event.target.value as SortMode)}>
          <option value="symbol">Token</option><option value="volume">Volume change</option>
          <option value="momentum">Price momentum</option><option value="updated">Last verified update</option>
        </select></label>
        <label className={styles.watchFilter}><input type="checkbox" checked={watchOnly} onChange={event => setWatchOnly(event.target.checked)} />
          Watchlist only</label>
      </div>
      <p className="muted" role="status">{rows.length} of {snapshot.rows.length} verified markets shown · {watched.size} watched in this session</p>
      {!rows.length && <p className="scanner-empty">
        <strong>{snapshot.rows.length ? 'No markets match these filters' : 'No verified Alpha observations'}</strong>
        <span>{snapshot.rows.length ? 'Try a different filter or add a market to your watchlist.' : 'Market values, scores, and activity stay unavailable until an approved source supplies evidence.'}</span>
      </p>}
      {rows.length > 0 && <div className={styles.markets}>{rows.map(row => <AlphaToken key={row.id} row={row} watched={watched.has(row.id)}
        toggleWatch={() => onToggleWatchlist(row.id)} />)}</div>}
    </section>
  </>;
}
