ALTER TABLE public.news_articles
    ADD COLUMN IF NOT EXISTS image_url TEXT;
