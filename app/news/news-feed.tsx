'use client';

import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState } from 'react';

type NewsItem = {
  id: string;
  headline: string;
  description: string;
  original_url: string;
  source_name: string;
  published_at: string | null;
  fetched_at: string;
  ticker_symbols: string[];
  category_key: string;
  category_label: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'BREAKING';
  unread: boolean;
};

type FeedData = {
  items: NewsItem[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
  settings: { newsEnabled: boolean };
};

type Preferences = {
  enabled_categories: string[];
  ticker_symbols: string[];
  breaking_notifications: boolean;
};

type Category = { category_key: string; label: string };

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Publication time unavailable';
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data?.csrfToken) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function NewsFeed({ userId }: { userId: number }) {
  const [data, setData] = useState<FeedData | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [category, setCategory] = useState('');
  const [ticker, setTicker] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [realtimeState, setRealtimeState] = useState(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ? 'Connecting'
      : 'Manual refresh',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (category) params.set('category', category);
      if (ticker.trim()) params.set('ticker', ticker.trim().toUpperCase());
      if (sentiment) params.set('sentiment', sentiment);
      if (priority) params.set('priority', priority);
      const response = await fetch(`/api/news?${params}`, { cache: 'no-store' });
      const body = await response.json() as { data?: FeedData; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'News feed could not be loaded.');
      setData(body.data);
      window.dispatchEvent(new CustomEvent('news-unread-count', { detail: body.data.unreadCount }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'News feed could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [category, page, priority, sentiment, ticker]);

  const loadPreferences = useCallback(async () => {
    const response = await fetch('/api/news/preferences', { cache: 'no-store' });
    const body = await response.json() as {
      data?: { preferences: Preferences; categories: Category[] };
      error?: string;
    };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'News preferences could not be loaded.');
    setPreferences(body.data.preferences);
    setCategories(body.data.categories);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      void loadPreferences().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'News preferences could not be loaded.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadPreferences]);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return;

    let active = true;
    let refreshTimer: number | undefined;
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const refreshAuth = async () => {
      const response = await fetch('/api/news/realtime-token', { cache: 'no-store' });
      const body = await response.json() as { data?: { token: string }; error?: string };
      if (!response.ok || !body.data?.token) throw new Error(body.error ?? 'Realtime authentication is unavailable.');
      await client.realtime.setAuth(body.data.token);
    };
    void refreshAuth().then(() => {
      if (!active) return;
      const channel = client.channel('published-news-feed')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'news_articles',
        }, () => { void load(); })
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'news_notifications',
          filter: `user_id=eq.${userId}`,
        }, () => { void load(); })
        .subscribe((status) => {
          if (!active) return;
          setRealtimeState(status === 'SUBSCRIBED' ? 'Live updates on' : status === 'CHANNEL_ERROR' ? 'Reconnect required' : 'Connecting');
        });
      refreshTimer = window.setInterval(() => {
        void refreshAuth().catch((reason: unknown) => {
          if (active) {
            setRealtimeState('Reconnect required');
            console.error('Realtime news token refresh failed:', reason);
          }
        });
      }, 8 * 60_000);
      return () => client.removeChannel(channel);
    }).catch((reason: unknown) => {
      if (active) {
        setRealtimeState('Manual refresh');
        console.error('News realtime setup failed:', reason);
      }
    });

    return () => {
      active = false;
      if (refreshTimer) window.clearInterval(refreshTimer);
      void client.removeAllChannels();
    };
  }, [load, userId]);

  const availableCategories = useMemo(
    () => categories.filter((item) => preferences?.enabled_categories.includes(item.category_key)),
    [categories, preferences],
  );
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function savePreferences() {
    if (!preferences) return;
    setSavingPreferences(true);
    setError('');
    setNotice('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/news/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({
          enabledCategories: preferences.enabled_categories,
          tickerSymbols: preferences.ticker_symbols,
          breakingNotifications: preferences.breaking_notifications,
        }),
      });
      const body = await response.json() as { data?: Preferences; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'News preferences could not be saved.');
      setPreferences(body.data);
      setNotice('News preferences saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'News preferences could not be saved.');
    } finally {
      setSavingPreferences(false);
    }
  }

  async function markBreakingRead() {
    try {
      const token = await csrfToken();
      const response = await fetch('/api/news', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ action: 'mark_read' }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Notifications could not be marked read.');
      setData((current) => current ? { ...current, unreadCount: 0 } : current);
      window.dispatchEvent(new CustomEvent('news-unread-count', { detail: 0 }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Notifications could not be marked read.');
    }
  }

  return <main className="shell">
    <header className="topbar"><span className="brand">ETHCRYPTOHUB</span></header>
    <section className="hero news-hero">
      <p className="mono">VERIFIED SOURCES · MARKET CONTEXT</p>
      <h1>Crypto news.</h1>
      <p className="muted">Publisher-attributed stories; news sentiment is informational and does not generate trading signals.</p>
    </section>
    <section className="card stack news-feed">
      <div className="news-feed-toolbar">
        <div><strong>Latest updates</strong><span className="mono">{realtimeState}</span></div>
        <div className="links">
          <span className="news-unread-count" aria-live="polite">{data?.unreadCount ?? 0} unread</span>
          <button type="button" className="button-secondary" onClick={() => void markBreakingRead()} disabled={!data?.unreadCount}>Mark alerts read</button>
          <button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>
      {!data?.settings.newsEnabled && <p className="muted">The administrator has temporarily disabled the news feed.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="success">{notice}</p>}
      <div className="news-filters">
        <label>Category<select value={category} onChange={(event) => { setPage(1); setCategory(event.target.value); }}>
          <option value="">All available</option>{availableCategories.map((item) => <option value={item.category_key} key={item.category_key}>{item.label}</option>)}
        </select></label>
        <label>Coin ticker<input value={ticker} maxLength={12} placeholder="BTC" onChange={(event) => { setPage(1); setTicker(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase()); }} /></label>
        <label>Sentiment<select value={sentiment} onChange={(event) => { setPage(1); setSentiment(event.target.value); }}>
          <option value="">Any sentiment</option><option value="BULLISH">Bullish</option><option value="BEARISH">Bearish</option><option value="NEUTRAL">Neutral</option>
        </select></label>
        <label>Priority<select value={priority} onChange={(event) => { setPage(1); setPriority(event.target.value); }}>
          <option value="">Any priority</option><option value="BREAKING">Breaking</option><option value="HIGH">High</option><option value="NORMAL">Normal</option>
        </select></label>
      </div>
      {preferences && <details className="news-preferences">
        <summary>Feed preferences</summary>
        <div className="news-preference-controls">
          <fieldset><legend>Categories</legend>{categories.map((item) => <label className="news-check" key={item.category_key}>
            <input type="checkbox" checked={preferences.enabled_categories.includes(item.category_key)}
              onChange={() => setPreferences((current) => current ? {
                ...current,
                enabled_categories: current.enabled_categories.includes(item.category_key)
                  ? current.enabled_categories.filter((key) => key !== item.category_key)
                  : [...current.enabled_categories, item.category_key],
              } : current)} />{item.label}
          </label>)}</fieldset>
          <label className="news-check"><input type="checkbox" checked={preferences.breaking_notifications}
            onChange={(event) => setPreferences((current) => current ? { ...current, breaking_notifications: event.target.checked } : current)} />
            Breaking-news notifications</label>
          <button type="button" onClick={() => void savePreferences()} disabled={savingPreferences}>{savingPreferences ? 'Saving…' : 'Save preferences'}</button>
        </div>
      </details>}
      {loading && !data && <p className="muted">Loading published news…</p>}
      {!loading && data?.items.length === 0 && <p className="muted">No published stories match these filters.</p>}
      <div className="news-article-list">
        {data?.items.map((item) => <article className={`news-article${item.priority === 'BREAKING' ? ' is-breaking' : ''}`} key={item.id}>
          <div className="news-article-meta">
            <span className="news-category">{item.category_label}</span>
            <span className={`news-sentiment is-${item.sentiment.toLowerCase()}`}>{item.sentiment === 'UNAVAILABLE' ? 'Sentiment unavailable' : item.sentiment}</span>
            {item.priority === 'BREAKING' && <span className="news-breaking-badge">BREAKING</span>}
            <time dateTime={item.published_at ?? item.fetched_at}>{relativeTime(item.published_at ?? item.fetched_at)}</time>
          </div>
          <h2><a href={item.original_url} target="_blank" rel="noopener noreferrer">{item.headline} <span aria-hidden="true">↗</span></a></h2>
          {item.description && <p>{item.description}</p>}
          <div className="news-article-footer"><span>{item.source_name}</span>
            {item.ticker_symbols.length > 0 && <span>{item.ticker_symbols.map((value) => `#${value}`).join(' ')}</span>}
          </div>
        </article>)}
      </div>
      {data && pageCount > 1 && <div className="signal-history-pagination">
        <span>Page {page} of {pageCount} · {data.total} stories</span>
        <button type="button" className="button-secondary" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading}>Previous</button>
        <button type="button" className="button-secondary" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount || loading}>Next</button>
      </div>}
    </section>
  </main>;
}
