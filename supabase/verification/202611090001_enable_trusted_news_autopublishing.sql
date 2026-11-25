-- Read-only verification for migration 202611090001_enable_trusted_news_autopublishing.sql.
SELECT source_key, is_trusted, auto_publish
  FROM public.news_sources
 WHERE source_key IN ('coindesk-rss', 'cointelegraph-rss');
