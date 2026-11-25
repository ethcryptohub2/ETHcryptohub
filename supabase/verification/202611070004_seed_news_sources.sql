-- Read-only verification for migration 202611070004_seed_news_sources.sql.
SELECT source_key, name, adapter, is_enabled
  FROM public.news_sources
 WHERE source_key IN ('coindesk-rss', 'cointelegraph-rss');
