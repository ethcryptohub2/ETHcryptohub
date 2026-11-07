'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Settings = {
  news_enabled: boolean;
  automatic_fetching: boolean;
  automatic_publishing: boolean;
  refresh_interval_minutes: number;
  allowed_categories: string[];
  sentiment_analysis_enabled: boolean;
  breaking_news_alerts_enabled: boolean;
  duplicate_detection_enabled: boolean;
  maximum_articles: number;
};

type Category = { id: number; category_key: string; label: string; is_enabled: boolean };
type Source = {
  id: number;
  source_key: string;
  name: string;
  adapter: 'CRYPTOPANIC' | 'RSS' | 'JSON_API';
  source_type: string;
  endpoint: string;
  configuration: Record<string, unknown>;
  allowed_categories: string[];
  is_enabled: boolean;
  is_trusted: boolean;
  auto_publish: boolean;
  refresh_interval_minutes: number | null;
  last_fetch_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  credential_configured: boolean;
  archived_at: string | null;
};
type Article = {
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
  sentiment: string;
  priority: string;
  verification_status: string;
  publication_status: string;
};
type Log = {
  id: string;
  source_name: string;
  status: string;
  fetched_count: number;
  stored_count: number;
  duplicate_count: number;
  published_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};
type Overview = { settings: Settings; categories: Category[]; sources: Source[]; articles: Article[]; logs: Log[] };
type ActionData = Overview | { ingestion: unknown; overview: Overview };

type SourceForm = {
  id?: number;
  sourceKey: string;
  name: string;
  adapter: Source['adapter'];
  sourceType: string;
  endpoint: string;
  credential: string;
  configuration: string;
  allowedCategories: string[];
  isEnabled: boolean;
  isTrusted: boolean;
  autoPublish: boolean;
  refreshIntervalMinutes: string;
};

function blankSource(): SourceForm {
  return {
    sourceKey: '',
    name: '',
    adapter: 'RSS',
    sourceType: 'RSS',
    endpoint: '',
    credential: '',
    configuration: '{}',
    allowedCategories: ['market'],
    isEnabled: true,
    isTrusted: false,
    autoPublish: false,
    refreshIntervalMinutes: '',
  };
}

async function csrfToken() {
  const response = await fetch('/api/csrf', { cache: 'no-store' });
  const body = await response.json() as { data?: { csrfToken: string } };
  if (!response.ok || !body.data?.csrfToken) throw new Error('Secure session unavailable.');
  return body.data.csrfToken;
}

export function AdminNewsSettings() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sourceForm, setSourceForm] = useState<SourceForm>(blankSource);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/news', { cache: 'no-store' });
      const body = await response.json() as { data?: Overview; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error ?? 'News settings could not be loaded.');
      setOverview(body.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'News settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function sendAction(action: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/admin/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(action),
      });
      const body = await response.json() as { data?: ActionData; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'News settings could not be saved.');
      if (body.data) setOverview('overview' in body.data ? body.data.overview : body.data);
      setNotice('News settings updated.');
      return body.data;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'News settings could not be saved.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function updateSettings(key: keyof Settings, value: Settings[keyof Settings]) {
    setOverview((current) => current ? {
      ...current,
      settings: { ...current.settings, [key]: value },
    } : current);
  }

  async function saveSource(event: FormEvent) {
    event.preventDefault();
    let configuration: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(sourceForm.configuration);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Source configuration must be a JSON object.');
      configuration = parsed as Record<string, unknown>;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Source mapping is invalid JSON.');
      return;
    }
    const result = await sendAction({
      action: 'save_source',
      source: {
        ...sourceForm,
        refreshIntervalMinutes: sourceForm.refreshIntervalMinutes ? Number(sourceForm.refreshIntervalMinutes) : null,
        credential: sourceForm.credential || undefined,
        configuration,
      },
    });
    if (result) setSourceForm(blankSource());
  }

  function editSource(source: Source) {
    setSourceForm({
      id: source.id,
      sourceKey: source.source_key,
      name: source.name,
      adapter: source.adapter,
      sourceType: source.source_type,
      endpoint: source.endpoint,
      credential: '',
      configuration: JSON.stringify(source.configuration, null, 2),
      allowedCategories: source.allowed_categories,
      isEnabled: source.is_enabled,
      isTrusted: source.is_trusted,
      autoPublish: source.auto_publish,
      refreshIntervalMinutes: source.refresh_interval_minutes?.toString() ?? '',
    });
  }

  if (loading && !overview) return <section className="card admin-news stack" id="admin-news"><h2>News feed management</h2><p className="muted">Loading persisted news configuration…</p></section>;

  return <section className="card admin-news stack" id="admin-news">
    <div className="admin-news-heading">
      <div><p className="mono">CONTENT OPERATIONS</p><h2>News feed management</h2>
        <p className="muted">Provider content stays unpublished until reviewed or explicitly allowed by trusted-source auto-publish rules. Credentials never return to this page.</p>
      </div>
      <button type="button" className="button-secondary" onClick={() => void load()} disabled={busy}>Refresh data</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!overview && <p className="muted">News configuration is unavailable.</p>}

    {overview && <>
      <form className="admin-news-settings stack" onSubmit={(event) => { event.preventDefault(); void sendAction({ action: 'update_settings', settings: overview.settings }); }}>
        <h3>Platform controls</h3>
        <div className="news-admin-setting-grid">
          <label className="news-check"><input type="checkbox" checked={overview.settings.news_enabled} onChange={(event) => updateSettings('news_enabled', event.target.checked)} />Enable news feed</label>
          <label className="news-check"><input type="checkbox" checked={overview.settings.automatic_fetching} onChange={(event) => updateSettings('automatic_fetching', event.target.checked)} />Automatic fetching</label>
          <label className="news-check"><input type="checkbox" checked={overview.settings.automatic_publishing} onChange={(event) => updateSettings('automatic_publishing', event.target.checked)} />Automatic publishing (trusted sources only)</label>
          <label className="news-check"><input type="checkbox" checked={overview.settings.sentiment_analysis_enabled} onChange={(event) => updateSettings('sentiment_analysis_enabled', event.target.checked)} />Rule-based sentiment labels</label>
          <label className="news-check"><input type="checkbox" checked={overview.settings.breaking_news_alerts_enabled} onChange={(event) => updateSettings('breaking_news_alerts_enabled', event.target.checked)} />Breaking-news notifications</label>
          <label className="news-check"><input type="checkbox" checked={overview.settings.duplicate_detection_enabled} onChange={(event) => updateSettings('duplicate_detection_enabled', event.target.checked)} />Cross-source headline duplicate check</label>
        </div>
        <div className="news-admin-number-grid">
          <label>Refresh interval (minutes)<input type="number" min={5} max={1440} value={overview.settings.refresh_interval_minutes} onChange={(event) => updateSettings('refresh_interval_minutes', Number(event.target.value))} /></label>
          <label>Maximum articles shown<input type="number" min={100} max={100000} value={overview.settings.maximum_articles} onChange={(event) => updateSettings('maximum_articles', Number(event.target.value))} /></label>
        </div>
        <fieldset className="news-admin-categories"><legend>Allowed categories</legend>
          {overview.categories.map((category) => <label className="news-check" key={category.category_key}>
            <input type="checkbox" checked={overview.settings.allowed_categories.includes(category.category_key)}
              onChange={() => updateSettings('allowed_categories', overview.settings.allowed_categories.includes(category.category_key)
                ? overview.settings.allowed_categories.filter((key) => key !== category.category_key)
                : [...overview.settings.allowed_categories, category.category_key])} />{category.label}
          </label>)}
        </fieldset>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save platform settings'}</button>
      </form>

      <div className="admin-news-source-section stack">
        <div className="admin-news-subheading"><h3>Sources</h3><button type="button" className="button-secondary" onClick={() => setSourceForm(blankSource())}>Add source</button></div>
        <p className="muted">Adapters support CryptoPanic, RSS/Atom, and mapped JSON APIs. Configure exchange, on-chain, and economic feeds as RSS or JSON sources.</p>
        {overview.sources.length === 0 && <p className="muted">No news sources configured.</p>}
        {overview.sources.map((source) => <article className="admin-news-source" key={source.id}>
          <div><strong>{source.name}</strong><span>{source.source_type} · {source.adapter} · {source.is_enabled ? 'Enabled' : 'Disabled'}</span>
            <small>{source.credential_configured ? 'Credential configured' : 'No provider credential'} · Last success {source.last_success_at ? new Date(source.last_success_at).toLocaleString() : 'never'}</small>
            {source.last_error && <small className="admin-news-source-error">{source.last_error}</small>}
          </div>
          <div className="links"><button type="button" className="button-secondary" onClick={() => editSource(source)}>Edit</button>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void sendAction({ action: 'archive_source', id: source.id })}>Delete</button>
          </div>
        </article>)}

        <form className="admin-news-source-form stack" onSubmit={(event) => void saveSource(event)}>
          <h3>{sourceForm.id ? 'Edit news source' : 'Add news source'}</h3>
          <div className="news-admin-number-grid">
            <label>Source key<input required minLength={2} maxLength={80} pattern="[a-z0-9][a-z0-9_-]*" value={sourceForm.sourceKey} onChange={(event) => setSourceForm({ ...sourceForm, sourceKey: event.target.value })} /></label>
            <label>Display name<input required minLength={2} maxLength={120} value={sourceForm.name} onChange={(event) => setSourceForm({ ...sourceForm, name: event.target.value })} /></label>
            <label>Adapter<select value={sourceForm.adapter} onChange={(event) => setSourceForm({ ...sourceForm, adapter: event.target.value as Source['adapter'], sourceType: event.target.value === 'RSS' ? 'RSS' : event.target.value === 'CRYPTOPANIC' ? 'CRYPTO_API' : 'JSON_API' })}>
              <option value="RSS">RSS / Atom</option><option value="CRYPTOPANIC">CryptoPanic API</option><option value="JSON_API">Mapped JSON API</option>
            </select></label>
            <label>Source type<select value={sourceForm.sourceType} onChange={(event) => setSourceForm({ ...sourceForm, sourceType: event.target.value })}>
              <option value="CRYPTO_API">Crypto news API</option><option value="RSS">RSS feed</option><option value="EXCHANGE_ANNOUNCEMENT">Exchange announcement</option><option value="ONCHAIN_ACTIVITY">On-chain activity</option><option value="ECONOMIC_CALENDAR">Economic calendar</option><option value="JSON_API">Other JSON API</option>
            </select></label>
          </div>
          <label>Public HTTPS endpoint<input type="url" required maxLength={2048} value={sourceForm.endpoint} onChange={(event) => setSourceForm({ ...sourceForm, endpoint: event.target.value })} /></label>
          <label>Provider credential (encrypted at rest)<input type="password" autoComplete="new-password" value={sourceForm.credential} placeholder={sourceForm.id ? 'Leave blank to keep current credential' : 'Required only by providers that need a key'} onChange={(event) => setSourceForm({ ...sourceForm, credential: event.target.value })} /></label>
          <label>JSON field mapping (object)
            <textarea rows={5} value={sourceForm.configuration} onChange={(event) => setSourceForm({ ...sourceForm, configuration: event.target.value })} aria-describedby="news-mapping-help" />
            <small id="news-mapping-help">Optional keys: itemsPath and mapping with headline, description, url, id, publishedAt, tickers, category, sentiment, priority.</small>
          </label>
          <fieldset className="news-admin-categories"><legend>Source categories</legend>
            {overview.categories.map((category) => <label className="news-check" key={category.category_key}>
              <input type="checkbox" checked={sourceForm.allowedCategories.includes(category.category_key)}
                onChange={() => setSourceForm({ ...sourceForm, allowedCategories: sourceForm.allowedCategories.includes(category.category_key)
                  ? sourceForm.allowedCategories.filter((key) => key !== category.category_key)
                  : [...sourceForm.allowedCategories, category.category_key] })} />{category.label}
            </label>)}
          </fieldset>
          <div className="news-admin-number-grid">
            <label>Source refresh interval (minutes, optional)<input type="number" min={5} max={1440} value={sourceForm.refreshIntervalMinutes} onChange={(event) => setSourceForm({ ...sourceForm, refreshIntervalMinutes: event.target.value })} /></label>
            <label className="news-check"><input type="checkbox" checked={sourceForm.isEnabled} onChange={(event) => setSourceForm({ ...sourceForm, isEnabled: event.target.checked })} />Source enabled</label>
            <label className="news-check"><input type="checkbox" checked={sourceForm.isTrusted} onChange={(event) => setSourceForm({ ...sourceForm, isTrusted: event.target.checked, autoPublish: event.target.checked ? sourceForm.autoPublish : false })} />Trusted source (manual admin review)</label>
            <label className="news-check"><input type="checkbox" checked={sourceForm.autoPublish} disabled={!sourceForm.isTrusted} onChange={(event) => setSourceForm({ ...sourceForm, autoPublish: event.target.checked })} />Allow automatic publishing</label>
          </div>
          <div className="links"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save source'}</button>
            {sourceForm.id && <button type="button" className="button-secondary" onClick={() => setSourceForm(blankSource())}>Cancel edit</button>}
          </div>
        </form>
        <button type="button" className="button-secondary" disabled={busy} onClick={async () => {
          await sendAction({ action: 'fetch_now' });
        }}>{busy ? 'Fetching…' : 'Fetch sources now'}</button>
      </div>

      <div className="admin-news-review stack">
        <h3>Review and publish</h3>
        {overview.articles.length === 0 && <p className="muted">No articles have been ingested.</p>}
        {overview.articles.map((article) => <article className="admin-news-article" key={article.id}>
          <div className="news-article-meta"><span className="news-category">{article.category_label}</span><span>{article.source_name}</span>
            <span>{article.verification_status} · {article.publication_status}</span><span>{article.priority}</span>
          </div>
          <h4><a href={article.original_url} target="_blank" rel="noopener noreferrer">{article.headline} ↗</a></h4>
          <p>{article.description}</p>
          <small>{article.ticker_symbols.map((ticker) => `#${ticker}`).join(' ') || 'No tickers'} · {new Date(article.fetched_at).toLocaleString()}</small>
          <div className="links">
            <button type="button" disabled={busy} onClick={() => void sendAction({ action: 'review_article', id: article.id, decision: 'publish' })}>Verify & publish</button>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void sendAction({ action: 'review_article', id: article.id, decision: 'reject' })}>Reject</button>
            <button type="button" className="button-secondary" disabled={busy} onClick={() => void sendAction({ action: 'review_article', id: article.id, decision: 'archive' })}>Archive</button>
          </div>
        </article>)}
      </div>

      <div className="admin-news-logs stack">
        <h3>Ingestion logs</h3>
        {overview.logs.length === 0 && <p className="muted">No ingestion runs logged yet.</p>}
        {overview.logs.map((log) => <article className="admin-news-log" key={log.id}>
          <strong>{log.source_name} · {log.status}</strong><span>{new Date(log.started_at).toLocaleString()}</span>
          <small>{log.fetched_count} fetched · {log.stored_count} stored · {log.duplicate_count} duplicates · {log.published_count} published</small>
          {log.error_message && <p className="error">{log.error_message}</p>}
        </article>)}
      </div>
    </>}
  </section>;
}
