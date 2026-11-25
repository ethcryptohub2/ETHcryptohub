-- Read-only verification for migration 202611090002_news_article_images.sql.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'news_articles'
   AND column_name = 'image_url';
