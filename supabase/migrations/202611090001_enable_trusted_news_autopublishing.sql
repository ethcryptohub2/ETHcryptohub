UPDATE public.platform_settings
   SET automatic_publishing = TRUE,
       updated_at = NOW()
 WHERE singleton = TRUE;

UPDATE public.news_sources
   SET is_trusted = TRUE,
       auto_publish = TRUE,
       updated_at = NOW()
 WHERE (source_key = 'coindesk-rss'
        AND adapter = 'RSS'
        AND endpoint = 'https://www.coindesk.com/arc/outboundfeeds/rss')
    OR (source_key = 'cointelegraph-rss'
        AND adapter = 'RSS'
        AND endpoint = 'https://cointelegraph.com/rss');
