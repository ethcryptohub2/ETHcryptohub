'use client';

/* eslint-disable @next/next/no-img-element -- Publisher image hosts are not known at build time. */
import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState } from 'react';

type NewsItem = {
  id: string;
  headline: string;
  description: string;
  image_url: string | null;
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

function decodeNewsEntities(value: string) {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const hexadecimal = code[1]?.toLowerCase() === 'x';
    const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff
      ? String.fromCodePoint(number)
      : entity;
  });
}

function cleanNewsText(value: string) {
  return decodeNewsEntities(value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\b[^>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeNewsImageUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
      url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') || url.hostname.endsWith('.internal') ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function legacyNewsImageUrl(description: string) {
  const image = description.match(/<img\b[^>]*>/i)?.[0];
  const source = image?.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const candidate = source?.[1] ?? source?.[2] ?? source?.[3];
  return safeNewsImageUrl(candidate ? decodeNewsEntities(candidate) : null);
}

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
      : 'Polling updates',
  );

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
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
      if (!quiet) setLoading(false);
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
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const refreshTimer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
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
          setRealtimeState(status === 'SUBSCRIBED' ? 'Live updates on' : status === 'CHANNEL_ERROR' ? 'Polling updates · realtime unavailable' : 'Connecting');
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
        setRealtimeState('Polling updates · realtime unavailable');
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
        {data?.items.map((item) => {
          const imageUrl = safeNewsImageUrl(item.image_url) ?? legacyNewsImageUrl(item.description);
          const description = cleanNewsText(item.description);
          return <article className={`news-article${item.priority === 'BREAKING' ? ' is-breaking' : ''}`} key={item.id}>
          <div className="news-article-meta">
            <span className="news-category">{item.category_label}</span>
            <span className={`news-sentiment is-${item.sentiment.toLowerCase()}`}>{item.sentiment === 'UNAVAILABLE' ? 'Sentiment unavailable' : item.sentiment}</span>
            {item.priority === 'BREAKING' && <span className="news-breaking-badge">BREAKING</span>}
            <time dateTime={item.published_at ?? item.fetched_at}>{relativeTime(item.published_at ?? item.fetched_at)}</time>
          </div>
          {imageUrl
            ? <><img className="news-article-image" src={imageUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                  event.currentTarget.nextElementSibling?.removeAttribute('hidden');
                }} />
              <div className="news-article-image-placeholder" hidden aria-hidden="true">Image unavailable</div></>
            : <div className="news-article-image-placeholder" aria-hidden="true">Publisher image unavailable</div>}
          <h2><a href={item.original_url} target="_blank" rel="noopener noreferrer">{item.headline} <span aria-hidden="true">↗</span></a></h2>
          {description && <p>{description}</p>}
          <div className="news-article-footer"><span>{item.source_name}</span>
            {item.ticker_symbols.length > 0 && <span>{item.ticker_symbols.map((value) => `#${value}`).join(' ')}</span>}
          </div>
          </article>;
        })}
      </div>
      {data && pageCount > 1 && <div className="signal-history-pagination">
        <span>Page {page} of {pageCount} · {data.total} stories</span>
        <button type="button" className="button-secondary" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading}>Previous</button>
        <button type="button" className="button-secondary" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount || loading}>Next</button>
      </div>}
    </section>
  </main>;
}
