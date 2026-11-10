import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query } from './db';
import { decryptCredential, encryptCredential } from './binance-credentials';
import type { IncomingNewsArticle } from '../smartexit/apps/api/src/services/news-aggregator';

export interface PlatformNewsSettings {
  news_enabled: boolean;
  automatic_fetching: boolean;
  automatic_publishing: boolean;
  refresh_interval_minutes: number;
  allowed_categories: string[];
  sentiment_analysis_enabled: boolean;
  breaking_news_alerts_enabled: boolean;
  duplicate_detection_enabled: boolean;
  maximum_articles: number;
}

export interface NewsCategory {
  id: number;
  category_key: string;
  label: string;
  is_enabled: boolean;
}

export interface NewsSourceRow {
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
}

export interface NewsArticleRow {
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
  sentiment: string;
  priority: string;
  verification_status: string;
  publication_status: string;
  unread: boolean;
}

const DEFAULT_CATEGORIES = ['market', 'exchange', 'onchain', 'economics', 'regulation', 'technology'];

export async function getPlatformNewsSettings(client?: PoolClient): Promise<PlatformNewsSettings> {
  const sql = `
    SELECT news_enabled, automatic_fetching, automatic_publishing,
            refresh_interval_minutes, allowed_categories, sentiment_analysis_enabled,
            breaking_news_alerts_enabled, duplicate_detection_enabled, maximum_articles
       FROM public.platform_settings WHERE singleton = TRUE`;
  const result = client
    ? await client.query<PlatformNewsSettings>(sql)
    : await query<PlatformNewsSettings>(sql);
  const settings = result.rows[0];
  if (!settings) throw new Error('Platform news settings are missing; apply the news platform migration.');
  return settings;
}

export async function updatePlatformNewsSettings(
  settings: PlatformNewsSettings,
  adminUserId: number,
): Promise<void> {
  await query(
    `UPDATE public.platform_settings
        SET news_enabled = $1, automatic_fetching = $2, automatic_publishing = $3,
            refresh_interval_minutes = $4, allowed_categories = $5::TEXT[],
            sentiment_analysis_enabled = $6, breaking_news_alerts_enabled = $7,
            duplicate_detection_enabled = $8, maximum_articles = $9,
            updated_at = NOW(), updated_by = $10
      WHERE singleton = TRUE`,
    [
      settings.news_enabled,
      settings.automatic_fetching,
      settings.automatic_publishing,
      settings.refresh_interval_minutes,
      settings.allowed_categories,
      settings.sentiment_analysis_enabled,
      settings.breaking_news_alerts_enabled,
      settings.duplicate_detection_enabled,
      settings.maximum_articles,
      adminUserId,
    ],
  );
}

export async function listNewsCategories(): Promise<NewsCategory[]> {
  const result = await query<NewsCategory>(
    `SELECT id, category_key, label, is_enabled
       FROM public.news_categories ORDER BY label`,
  );
  return result.rows;
}

const sourceSelect = `
  SELECT id, source_key, name, adapter, source_type, endpoint, configuration,
         allowed_categories, is_enabled, is_trusted, auto_publish,
         refresh_interval_minutes, last_fetch_at, last_success_at, last_error,
         (credential_ciphertext IS NOT NULL) AS credential_configured, archived_at
    FROM public.news_sources`;

export async function listNewsSources(includeArchived = false): Promise<NewsSourceRow[]> {
  const result = await query<NewsSourceRow>(
    `${sourceSelect} ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY name`,
  );
  return result.rows;
}

export async function saveNewsSource(input: {
  id?: number;
  sourceKey: string;
  name: string;
  adapter: NewsSourceRow['adapter'];
  sourceType: NewsSourceRow['source_type'];
  endpoint: string;
  credential?: string;
  configuration: Record<string, unknown>;
  allowedCategories: string[];
  isEnabled: boolean;
  isTrusted: boolean;
  autoPublish: boolean;
  refreshIntervalMinutes: number | null;
}): Promise<void> {
  const knownCategories = new Set(DEFAULT_CATEGORIES);
  if (input.allowedCategories.some((category) => !knownCategories.has(category))) {
    throw new Error('News source contains an unsupported category.');
  }
  if (!input.id) {
    const count = await query<{ total: string }>(
      'SELECT COUNT(*)::TEXT AS total FROM public.news_sources WHERE archived_at IS NULL',
    );
    if (Number(count.rows[0]?.total ?? 0) >= 50) throw new Error('The maximum of 50 configured news sources has been reached.');
  }
  const encryptedCredential = input.credential?.trim() ? encryptCredential(input.credential.trim()) : null;
  if (input.id) {
    const updated = await query(
      `UPDATE public.news_sources SET source_key = $2, name = $3, adapter = $4, source_type = $5,
              endpoint = $6, credential_ciphertext = COALESCE($7, credential_ciphertext),
              configuration = $8::JSONB, allowed_categories = $9::TEXT[],
              is_enabled = $10, is_trusted = $11, auto_publish = $12,
              refresh_interval_minutes = $13, updated_at = NOW()
        WHERE id = $1 AND archived_at IS NULL`,
      [
        input.id,
        input.sourceKey,
        input.name,
        input.adapter,
        input.sourceType,
        input.endpoint,
        encryptedCredential,
        JSON.stringify(input.configuration),
        input.allowedCategories,
        input.isEnabled,
        input.isTrusted,
        input.autoPublish,
        input.refreshIntervalMinutes,
      ],
    );
    if (!updated.rowCount) throw new Error('News source not found or already archived.');
    return;
  }
  await query(
    `INSERT INTO public.news_sources (
       source_key, name, adapter, source_type, endpoint, credential_ciphertext,
       configuration, allowed_categories, is_enabled, is_trusted, auto_publish,
       refresh_interval_minutes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::TEXT[], $9, $10, $11, $12)`,
    [
      input.sourceKey,
      input.name,
      input.adapter,
      input.sourceType,
      input.endpoint,
      encryptedCredential,
      JSON.stringify(input.configuration),
      input.allowedCategories,
      input.isEnabled,
      input.isTrusted,
      input.autoPublish,
      input.refreshIntervalMinutes,
    ],
  );
}

export async function archiveNewsSource(id: number): Promise<void> {
  const archived = await query(
    `UPDATE public.news_sources
        SET is_enabled = FALSE, auto_publish = FALSE, archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL`,
    [id],
  );
  if (!archived.rowCount) throw new Error('News source not found or already archived.');
}

const ADMIN_NEWS_PAGE_SIZE = 20;

export async function listAdminNewsArticles(input: { page?: number; status?: 'PENDING' | 'PUBLISHED' } = {}) {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const status = input.status ?? 'PENDING';
  const offset = (page - 1) * ADMIN_NEWS_PAGE_SIZE;
  const [result, counts] = await Promise.all([
    query(
      `SELECT a.id::TEXT AS id, a.headline, a.description, a.image_url, a.original_url,
              a.source_name, a.published_at, a.fetched_at, a.ticker_symbols,
              c.category_key, c.label AS category_label, a.sentiment, a.priority,
              a.verification_status, a.publication_status
         FROM public.news_articles a
         JOIN public.news_categories c ON c.id = a.category_id
        WHERE a.publication_status = $1
        ORDER BY a.fetched_at DESC, a.id DESC
        LIMIT $2 OFFSET $3`,
      [status, ADMIN_NEWS_PAGE_SIZE, offset],
    ),
    query<{ pending: string; published: string }>(
      `SELECT COUNT(*) FILTER (WHERE publication_status = 'PENDING')::TEXT AS pending,
              COUNT(*) FILTER (WHERE publication_status = 'PUBLISHED')::TEXT AS published
         FROM public.news_articles`,
    ),
  ]);
  const pendingTotal = Number(counts.rows[0]?.pending ?? 0);
  const publishedTotal = Number(counts.rows[0]?.published ?? 0);
  return {
    items: result.rows,
    total: status === 'PENDING' ? pendingTotal : publishedTotal,
    pendingTotal,
    publishedTotal,
    page,
    pageSize: ADMIN_NEWS_PAGE_SIZE,
    status,
  };
}

export async function getAdminNewsOverview(input: { page?: number; status?: 'PENDING' | 'PUBLISHED' } = {}) {
  const [settings, categories, sources, articles, logs] = await Promise.all([
    getPlatformNewsSettings(),
    listNewsCategories(),
    listNewsSources(),
    listAdminNewsArticles(input),
    listNewsProcessingLogs(),
  ]);
  return { settings, categories, sources, articles: articles.items, articlePagination: articles, logs };
}

export async function listNewsProcessingLogs(limit = 100) {
  const result = await query(
    `SELECT id::TEXT AS id, source_name, status, fetched_count, stored_count,
            duplicate_count, published_count, error_message, started_at, finished_at
       FROM public.news_processing_logs
      ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return result.rows;
}

async function createBreakingNotifications(
  client: PoolClient,
  articleId: string,
  categoryKey: string,
  tickerSymbols: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO public.news_notifications (user_id, article_id)
     SELECT u.id, $1
       FROM public.users u
       LEFT JOIN public.news_user_preferences p ON p.user_id = u.id
      WHERE u.is_active = 1 AND u.is_email_verified = 1
        AND COALESCE(p.breaking_notifications, TRUE)
        AND COALESCE(p.enabled_categories, $2::TEXT[]) @> ARRAY[$3]::TEXT[]
        AND (
          COALESCE(cardinality(p.ticker_symbols), 0) = 0
          OR cardinality($4::TEXT[]) = 0
          OR p.ticker_symbols && $4::TEXT[]
        )
     ON CONFLICT (user_id, article_id) DO NOTHING`,
    [articleId, DEFAULT_CATEGORIES, categoryKey, tickerSymbols],
  );
}

export async function storeFetchedNewsArticle(
  source: { id: number; name: string },
  article: IncomingNewsArticle,
  categoryId: number,
  publication: { publish: boolean; issueBreakingNotifications: boolean },
  connection?: PoolClient,
): Promise<'stored' | 'duplicate'> {
  const client = connection ?? await pool().connect();
  const ownsConnection = !connection;
  try {
    await client.query('BEGIN');
    const saved = await client.query<{ id: string }>(
      `INSERT INTO public.news_articles (
         source_id, external_id, article_key, canonical_url, headline, description, image_url,
         original_url, source_name, published_at, ticker_symbols, category_id,
         sentiment, priority, verification_status, publication_status,
         published_at_admin
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::TIMESTAMPTZ, $11::TEXT[], $12,
         $13, $14, $15, $16,
         CASE WHEN $17 THEN NOW() ELSE NULL END
       )
       ON CONFLICT DO NOTHING
       RETURNING id::TEXT AS id`,
      [
        source.id,
        article.externalId,
        createHash('sha256').update(`${source.id}:${article.externalId}:${article.canonicalUrl}`).digest('hex'),
        article.canonicalUrl,
        article.headline,
        article.description,
        article.imageUrl,
        article.originalUrl,
        source.name,
        article.publishedAt,
        article.tickerSymbols,
        categoryId,
        article.sentiment,
        article.priority,
        publication.publish ? 'VERIFIED' : 'PENDING',
        publication.publish ? 'PUBLISHED' : 'PENDING',
        publication.publish,
      ],
    );
    const articleId = saved.rows[0]?.id;
    if (!articleId) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    if (publication.publish && publication.issueBreakingNotifications && article.priority === 'BREAKING') {
      await createBreakingNotifications(client, articleId, article.categoryKey, article.tickerSymbols);
    }
    await client.query('COMMIT');
    return 'stored';
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('News article transaction rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
    }
    throw error;
  } finally {
    if (ownsConnection) client.release();
  }
}

export async function reviewNewsArticle(
  articleId: string,
  action: 'publish' | 'reject' | 'archive',
  adminUserId: number,
  issueBreakingNotifications: boolean,
): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: string;
      category_key: string;
      ticker_symbols: string[];
      priority: string;
    }>(
      `SELECT a.id::TEXT AS id, c.category_key, a.ticker_symbols, a.priority
         FROM public.news_articles a
         JOIN public.news_categories c ON c.id = a.category_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [articleId],
    );
    const article = result.rows[0];
    if (!article) throw new Error('News article not found.');
    const publicationStatus = action === 'publish' ? 'PUBLISHED' : action === 'archive' ? 'ARCHIVED' : 'REJECTED';
    const verificationStatus = action === 'publish' ? 'VERIFIED' : action === 'reject' ? 'REJECTED' : 'PENDING';
    await client.query(
      `UPDATE public.news_articles
          SET publication_status = $2::TEXT, verification_status = $3,
              published_by = CASE WHEN $2::TEXT = 'PUBLISHED' THEN $4 ELSE published_by END,
              published_at_admin = CASE WHEN $2::TEXT = 'PUBLISHED' THEN NOW() ELSE published_at_admin END,
              updated_at = NOW()
        WHERE id = $1`,
      [articleId, publicationStatus, verificationStatus, adminUserId],
    );
    if (action === 'publish' && issueBreakingNotifications && article.priority === 'BREAKING') {
      await createBreakingNotifications(client, articleId, article.category_key, article.ticker_symbols);
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('News review transaction rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function publishPendingNewsArticles(
  articleIds: string[],
  adminUserId: number,
  issueBreakingNotifications: boolean,
): Promise<number> {
  const ids = [...new Set(articleIds)];
  if (!ids.length || ids.length !== articleIds.length) throw new Error('Select one or more distinct pending articles.');
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{
      id: string;
      category_key: string;
      ticker_symbols: string[];
      priority: string;
    }>(
      `SELECT a.id::TEXT AS id, c.category_key, a.ticker_symbols, a.priority
         FROM public.news_articles a
         JOIN public.news_categories c ON c.id = a.category_id
        WHERE a.id = ANY($1::BIGINT[]) AND a.publication_status = 'PENDING'
        ORDER BY a.id
        FOR UPDATE OF a`,
      [ids],
    );
    if (selected.rows.length !== ids.length) {
      throw new Error('Some selected articles are no longer pending. Refresh the list and select articles again.');
    }

    const updated = await client.query(
      `UPDATE public.news_articles
          SET publication_status = 'PUBLISHED', verification_status = 'VERIFIED',
              published_by = $2, published_at_admin = NOW(), updated_at = NOW()
        WHERE id = ANY($1::BIGINT[]) AND publication_status = 'PENDING'`,
      [ids, adminUserId],
    );
    if (updated.rowCount !== ids.length) throw new Error('Not all selected articles could be published.');

    if (issueBreakingNotifications) {
      for (const article of selected.rows) {
        if (article.priority === 'BREAKING') {
          await createBreakingNotifications(client, article.id, article.category_key, article.ticker_symbols);
        }
      }
    }
    await client.query('COMMIT');
    return updated.rowCount;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Bulk news publication rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getPublishedNews(input: {
  userId: number;
  page: number;
  pageSize: number;
  category?: string;
  ticker?: string;
  sentiment?: string;
  priority?: string;
}) {
  const [settings, userPrefs] = await Promise.all([
    getPlatformNewsSettings(),
    getNewsUserPreferences(input.userId),
  ]);
  if (!settings.news_enabled) {
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize, unreadCount: await getUnreadNewsCount(input.userId), settings: { newsEnabled: false } };
  }
  const values: unknown[] = [settings.allowed_categories, userPrefs.enabled_categories];
  const clauses = [
    `a.publication_status = 'PUBLISHED'`,
    `a.verification_status = 'VERIFIED'`,
    `c.is_enabled = TRUE`,
    `c.category_key = ANY($1::TEXT[])`,
    `c.category_key = ANY($2::TEXT[])`,
  ];
  const add = (clause: (index: number) => string, value: unknown) => {
    values.push(value);
    clauses.push(clause(values.length));
  };
  if (input.category) add((i) => `c.category_key = $${i}`, input.category);
  if (input.ticker) add((i) => `a.ticker_symbols @> ARRAY[$${i}]::TEXT[]`, input.ticker);
  if (input.sentiment) add((i) => `a.sentiment = $${i}`, input.sentiment);
  if (input.priority) add((i) => `a.priority = $${i}`, input.priority);
  const where = clauses.join(' AND ');
  const pageSize = Math.min(input.pageSize, settings.maximum_articles, 100);
  const offset = (input.page - 1) * pageSize;
  const rows = await query<NewsArticleRow>(
    `SELECT a.id::TEXT AS id, a.headline, a.description, a.image_url, a.original_url,
            a.source_name, a.published_at, a.fetched_at, a.ticker_symbols,
            c.category_key, c.label AS category_label, a.sentiment, a.priority,
            a.verification_status, a.publication_status,
            EXISTS (
              SELECT 1 FROM public.news_notifications n
               WHERE n.user_id = $${values.length + 1}
                 AND n.article_id = a.id AND n.read_at IS NULL
            ) AS unread
       FROM public.news_articles a
       JOIN public.news_categories c ON c.id = a.category_id
      WHERE ${where}
      ORDER BY (a.priority = 'BREAKING') DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
      LIMIT $${values.length + 2} OFFSET $${values.length + 3}`,
    [...values, input.userId, pageSize, offset],
  );
  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total
       FROM public.news_articles a
       JOIN public.news_categories c ON c.id = a.category_id
      WHERE ${where}`,
    values,
  );
  const unread = await getUnreadNewsCount(input.userId);
  return {
    items: rows.rows,
    total: Number(count.rows[0]?.total ?? 0),
    page: input.page,
    pageSize,
    unreadCount: unread,
    settings: { newsEnabled: settings.news_enabled },
  };
}

export async function getUnreadNewsCount(userId: number): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM public.news_notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function markNewsNotificationsRead(userId: number, ids?: string[]): Promise<void> {
  if (ids?.length) {
    await query(
      `UPDATE public.news_notifications SET read_at = NOW()
        WHERE user_id = $1 AND id = ANY($2::BIGINT[]) AND read_at IS NULL`,
      [userId, ids],
    );
  } else {
    await query(
      `UPDATE public.news_notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }
}

export async function getNewsUserPreferences(userId: number) {
  await query(
    `INSERT INTO public.news_user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await query<{
    enabled_categories: string[];
    ticker_symbols: string[];
    breaking_notifications: boolean;
  }>(
    `SELECT enabled_categories, ticker_symbols, breaking_notifications
       FROM public.news_user_preferences WHERE user_id = $1`,
    [userId],
  );
  if (!result.rows[0]) throw new Error('News preferences could not be loaded.');
  return result.rows[0];
}

export async function updateNewsUserPreferences(
  userId: number,
  preferences: { enabledCategories: string[]; tickerSymbols: string[]; breakingNotifications: boolean },
): Promise<void> {
  await query(
    `INSERT INTO public.news_user_preferences (
       user_id, enabled_categories, ticker_symbols, breaking_notifications, updated_at
     ) VALUES ($1, $2::TEXT[], $3::TEXT[], $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       enabled_categories = EXCLUDED.enabled_categories,
       ticker_symbols = EXCLUDED.ticker_symbols,
       breaking_notifications = EXCLUDED.breaking_notifications,
       updated_at = NOW()`,
    [userId, preferences.enabledCategories, preferences.tickerSymbols, preferences.breakingNotifications],
  );
}

export async function getAdminNewsArticle(articleId: string) {
  const result = await query(
    `SELECT id::TEXT AS id, priority FROM public.news_articles WHERE id = $1`,
    [articleId],
  );
  return result.rows[0] ?? null;
}

export async function getNewsSourceCredential(ciphertext: string | null): Promise<string | null> {
  return ciphertext ? decryptCredential(ciphertext) : null;
}

export async function listRunnableNewsSources(client?: PoolClient) {
  type RunnableNewsSource = {
    id: number;
    source_key: string;
    name: string;
    adapter: 'CRYPTOPANIC' | 'RSS' | 'JSON_API';
    source_type: string;
    endpoint: string;
    credential_ciphertext: string | null;
    configuration: Record<string, unknown>;
    allowed_categories: string[];
    is_trusted: boolean;
    auto_publish: boolean;
    refresh_interval_minutes: number | null;
    last_fetch_at: string | null;
  };
  const sql = `
    SELECT id, source_key, name, adapter, source_type, endpoint, credential_ciphertext,
           configuration, allowed_categories, is_trusted, auto_publish,
           refresh_interval_minutes, last_fetch_at
      FROM public.news_sources
     WHERE is_enabled = TRUE AND archived_at IS NULL
     ORDER BY last_fetch_at NULLS FIRST, id
     LIMIT 50`;
  const result = client
    ? await client.query<RunnableNewsSource>(sql)
    : await query<RunnableNewsSource>(sql);
  return result.rows;
}

export async function updateNewsSourceFetchState(
  id: number,
  state: { successful: boolean; error: string | null },
  client?: PoolClient,
): Promise<void> {
  const sql = `UPDATE public.news_sources
        SET last_fetch_at = NOW(),
            last_success_at = CASE WHEN $2 THEN NOW() ELSE last_success_at END,
            last_error = $3, updated_at = NOW()
      WHERE id = $1`;
  if (client) await client.query(sql, [id, state.successful, state.error]);
  else await query(sql, [id, state.successful, state.error]);
}

export async function addNewsProcessingLog(input: {
  sourceId: number | null;
  sourceName: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  fetched: number;
  stored: number;
  duplicates: number;
  published: number;
  error: string | null;
  startedAt: string;
  client?: PoolClient;
}): Promise<void> {
  const sql = `INSERT INTO public.news_processing_logs (
       source_id, source_name, status, fetched_count, stored_count,
       duplicate_count, published_count, error_message, started_at, finished_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::TIMESTAMPTZ, NOW())`;
  const values = [
      input.sourceId,
      input.sourceName,
      input.status,
      input.fetched,
      input.stored,
      input.duplicates,
      input.published,
      input.error?.slice(0, 1000) ?? null,
      input.startedAt,
    ];
  if (input.client) await input.client.query(sql, values);
  else await query(sql, values);
}
