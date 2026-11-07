import { z } from 'zod';
import { NextRequest } from 'next/server';
import { AuthError, requireAdmin } from '../../../../lib/auth';
import { validCsrf } from '../../../../lib/http';
import { runNewsIngestion } from '../../../../lib/news-ingestion';
import {
  archiveNewsSource,
  getAdminNewsOverview,
  getPlatformNewsSettings,
  reviewNewsArticle,
  saveNewsSource,
  updatePlatformNewsSettings,
} from '../../../../lib/news-store';
import { isSafeNewsEndpoint } from '../../../../smartexit/apps/api/src/services/news-aggregator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NEWS_CATEGORIES = new Set(['market', 'exchange', 'onchain', 'economics', 'regulation', 'technology']);
const categoryKey = z.string().refine((value) => NEWS_CATEGORIES.has(value), 'Unsupported news category.');
function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    /api.?key|secret|token|password/i.test(key) || containsSecretField(child),
  );
}

const settingsSchema = z.object({
  news_enabled: z.boolean(),
  automatic_fetching: z.boolean(),
  automatic_publishing: z.boolean(),
  refresh_interval_minutes: z.number().int().min(5).max(1440),
  allowed_categories: z.array(categoryKey).max(20),
  sentiment_analysis_enabled: z.boolean(),
  breaking_news_alerts_enabled: z.boolean(),
  duplicate_detection_enabled: z.boolean(),
  maximum_articles: z.number().int().min(100).max(100_000),
}).strict();

const sourceSchema = z.object({
  id: z.number().int().positive().optional(),
  sourceKey: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().trim().min(2).max(120),
  adapter: z.enum(['CRYPTOPANIC', 'RSS', 'JSON_API']),
  sourceType: z.enum(['CRYPTO_API', 'RSS', 'EXCHANGE_ANNOUNCEMENT', 'ONCHAIN_ACTIVITY', 'ECONOMIC_CALENDAR', 'JSON_API']),
  endpoint: z.string().url().max(2048),
  credential: z.string().max(2048).optional(),
  configuration: z.record(z.string(), z.unknown()).default({})
    .refine((value) => JSON.stringify(value).length <= 10_000)
    .refine((value) => !containsSecretField(value), 'Credentials must be submitted through the encrypted credential field.'),
  allowedCategories: z.array(categoryKey).min(1).max(20),
  isEnabled: z.boolean(),
  isTrusted: z.boolean(),
  autoPublish: z.boolean(),
  refreshIntervalMinutes: z.number().int().min(5).max(1440).nullable(),
}).strict().refine((value) => !value.autoPublish || value.isTrusted, {
  message: 'Only trusted sources can be set to automatically publish.',
  path: ['autoPublish'],
}).refine((value) =>
  value.adapter === 'CRYPTOPANIC'
    ? value.sourceType === 'CRYPTO_API'
    : value.adapter === 'RSS'
      ? ['RSS', 'EXCHANGE_ANNOUNCEMENT', 'ONCHAIN_ACTIVITY', 'ECONOMIC_CALENDAR'].includes(value.sourceType)
      : value.sourceType !== 'CRYPTO_API',
{
  message: 'The source type does not match the selected provider adapter.',
  path: ['sourceType'],
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update_settings'), settings: settingsSchema }).strict(),
  z.object({ action: z.literal('save_source'), source: sourceSchema }).strict(),
  z.object({ action: z.literal('archive_source'), id: z.number().int().positive() }).strict(),
  z.object({
    action: z.literal('review_article'),
    id: z.string().regex(/^\d{1,20}$/),
    decision: z.enum(['publish', 'reject', 'archive']),
  }).strict(),
  z.object({ action: z.literal('fetch_now') }).strict(),
]);

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ data: await getAdminNewsOverview() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : 'News administration is unavailable.' }, { status });
  }
}

export async function POST(request: NextRequest) {
  if (!validCsrf(request)) return Response.json({ error: 'Refresh and retry.' }, { status: 403 });
  try {
    const admin = await requireAdmin();
    const body: unknown = await request.json().catch(() => null);
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Invalid news administration request.' }, { status: 422 });

    switch (parsed.data.action) {
      case 'update_settings': {
        await updatePlatformNewsSettings(parsed.data.settings, admin.id);
        break;
      }
      case 'save_source': {
        if (!isSafeNewsEndpoint(parsed.data.source.endpoint)) {
          return Response.json({ error: 'News sources must use a public HTTPS endpoint.' }, { status: 422 });
        }
        await saveNewsSource(parsed.data.source);
        break;
      }
      case 'archive_source':
        await archiveNewsSource(parsed.data.id);
        break;
      case 'review_article': {
        const settings = await getPlatformNewsSettings();
        await reviewNewsArticle(
          parsed.data.id,
          parsed.data.decision,
          admin.id,
          settings.breaking_news_alerts_enabled,
        );
        break;
      }
      case 'fetch_now':
        return Response.json({ data: { ingestion: await runNewsIngestion({ manual: true }), overview: await getAdminNewsOverview() } }, {
          headers: { 'Cache-Control': 'no-store' },
        });
    }

    return Response.json({ data: await getAdminNewsOverview() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    console.error('Admin news action failed:', error instanceof Error ? error.message : 'Unknown error.');
    return Response.json(
      { error: error instanceof Error ? error.message : 'News administration request failed.' },
      { status },
    );
  }
}
