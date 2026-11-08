import { connectDedicatedClient, query } from './db';
import {
  getPlatformNewsSettings,
  getNewsSourceCredential,
  listRunnableNewsSources,
  storeFetchedNewsArticle,
  updateNewsSourceFetchState,
  addNewsProcessingLog,
} from './news-store';
import {
  fetchNormalizedNews,
  shouldAutoPublishNews,
  type NewsSourceAdapterConfig,
} from '../smartexit/apps/api/src/services/news-aggregator';

const NEWS_INGESTION_LOCK = 'ethcryptohub-news-ingestion';
const MAX_STORED_PER_RUN = 500;

function sourceAdapterConfig(source: Awaited<ReturnType<typeof listRunnableNewsSources>>[number]): NewsSourceAdapterConfig {
  return {
    id: source.id,
    sourceKey: source.source_key,
    name: source.name,
    adapter: source.adapter,
    sourceType: source.source_type as NewsSourceAdapterConfig['sourceType'],
    endpoint: source.endpoint,
    configuration: source.configuration ?? {},
    allowedCategories: source.allowed_categories,
    isTrusted: source.is_trusted,
    autoPublish: source.auto_publish,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown provider error.';
  return message.replace(/(auth[_-]?token|api[_-]?key|token|secret|signature)=([^&\s]+)/gi, '$1=[redacted]').slice(0, 1000);
}

async function categoryMap(): Promise<Map<string, number>> {
  const result = await query<{ id: number; category_key: string; is_enabled: boolean }>(
    'SELECT id, category_key, is_enabled FROM public.news_categories',
  );
  return new Map(result.rows.filter((row) => row.is_enabled).map((row) => [row.category_key, row.id]));
}

async function isNearDuplicate(headline: string, canonicalUrl: string): Promise<boolean> {
  const result = await query<{ duplicate: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.news_articles
        WHERE canonical_url = $1
           OR (LOWER(headline) = LOWER($2) AND fetched_at >= NOW() - INTERVAL '7 days')
     ) AS duplicate`,
    [canonicalUrl, headline],
  );
  return result.rows[0]?.duplicate ?? false;
}

export async function runNewsIngestion(options: { manual?: boolean } = {}) {
  const settings = await getPlatformNewsSettings();
  if (!settings.news_enabled) return { status: 'DISABLED' as const, sources: 0, stored: 0, duplicates: 0, published: 0, errors: 0 };
  if (!options.manual && !settings.automatic_fetching) {
    return { status: 'PAUSED' as const, sources: 0, stored: 0, duplicates: 0, published: 0, errors: 0 };
  }

  const client = await connectDedicatedClient();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [NEWS_INGESTION_LOCK],
    );
    locked = lock.rows[0]?.locked ?? false;
    if (!locked) return { status: 'BUSY' as const, sources: 0, stored: 0, duplicates: 0, published: 0, errors: 0 };

    if (options.manual) {
      const recent = await query<{ recent: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.news_processing_logs
            WHERE source_id IS NULL AND source_name = 'Manual admin fetch'
              AND started_at > NOW() - INTERVAL '5 minutes'
         ) AS recent`,
      );
      if (recent.rows[0]?.recent) {
        return { status: 'RATE_LIMITED' as const, sources: 0, stored: 0, duplicates: 0, published: 0, errors: 0 };
      }
    }

    const [sources, categories] = await Promise.all([listRunnableNewsSources(), categoryMap()]);
    const totals = { sources: sources.length, stored: 0, duplicates: 0, published: 0, errors: 0 };
    const runStartedAt = new Date().toISOString();
    const now = Date.now();
    const articleCount = await query<{ total: string }>(
      'SELECT COUNT(*)::TEXT AS total FROM public.news_articles',
    );
    let remainingCapacity = Math.min(
      Math.max(0, settings.maximum_articles - Number(articleCount.rows[0]?.total ?? 0)),
      MAX_STORED_PER_RUN,
    );
    for (const source of sources) {
      const interval = (source.refresh_interval_minutes ?? settings.refresh_interval_minutes) * 60_000;
      const lastFetch = source.last_fetch_at ? Date.parse(source.last_fetch_at) : 0;
      if (!options.manual && lastFetch && now - lastFetch < interval) continue;

      const startedAt = new Date().toISOString();
      let fetched = 0;
      let stored = 0;
      let duplicates = 0;
      let published = 0;
      let failure: string | null = null;
      try {
        const credential = await getNewsSourceCredential(source.credential_ciphertext);
        const incoming = await fetchNormalizedNews(
          sourceAdapterConfig(source),
          credential,
          settings.sentiment_analysis_enabled,
        );
        fetched = incoming.length;
        const permittedCategories = new Set(settings.allowed_categories);
        const canAutoPublish = shouldAutoPublishNews(
          { newsEnabled: settings.news_enabled, automaticPublishing: settings.automatic_publishing },
          { enabled: true, trusted: source.is_trusted, autoPublish: source.auto_publish },
        );
        const sendBreakingAlerts = settings.breaking_news_alerts_enabled;

        for (const article of incoming) {
          if (remainingCapacity <= 0) break;
          if (!permittedCategories.has(article.categoryKey)) continue;
          const categoryId = categories.get(article.categoryKey);
          if (!categoryId) continue;
          if (settings.duplicate_detection_enabled &&
              await isNearDuplicate(article.headline, article.canonicalUrl)) {
            duplicates += 1;
            continue;
          }
          const status = await storeFetchedNewsArticle(
            { id: source.id, name: source.name },
            article,
            categoryId,
            { publish: canAutoPublish, issueBreakingNotifications: sendBreakingAlerts },
          );
          if (status === 'duplicate') {
            duplicates += 1;
            continue;
          }
          stored += 1;
          remainingCapacity -= 1;
          if (canAutoPublish) published += 1;
        }
      } catch (error) {
        failure = errorMessage(error);
        totals.errors += 1;
      }

      await updateNewsSourceFetchState(source.id, { successful: failure === null, error: failure });
      totals.stored += stored;
      totals.duplicates += duplicates;
      totals.published += published;
      await addNewsProcessingLog({
        sourceId: source.id,
        sourceName: source.name,
        status: failure ? (stored > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCESS',
        fetched,
        stored,
        duplicates,
        published,
        error: failure,
        startedAt,
      });
    }

    await addNewsProcessingLog({
      sourceId: null,
      sourceName: options.manual ? 'Manual admin fetch' : 'Scheduled ingestion',
      status: totals.errors ? 'PARTIAL' : 'SUCCESS',
      fetched: 0,
      stored: totals.stored,
      duplicates: totals.duplicates,
      published: totals.published,
      error: totals.errors ? `${totals.errors} source(s) failed.` : null,
      startedAt: runStartedAt,
    });

    return {
      status: totals.errors ? 'PARTIAL' as const : 'SUCCESS' as const,
      ...totals,
    };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [NEWS_INGESTION_LOCK]);
      } catch (error) {
        console.error('News ingestion lock release failed:', error instanceof Error ? error.message : 'Unknown database error.');
      }
    }
    try {
      await client.end();
    } catch (error) {
      console.error('News ingestion lock connection close failed:', error instanceof Error ? error.message : 'Unknown database error.');
    }
  }
}
