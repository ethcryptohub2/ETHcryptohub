INSERT INTO public.news_sources (
    source_key,
    name,
    adapter,
    source_type,
    endpoint,
    configuration,
    allowed_categories,
    is_enabled,
    is_trusted,
    auto_publish
)
VALUES
    (
        'coindesk-rss',
        'CoinDesk RSS',
        'RSS',
        'RSS',
        'https://www.coindesk.com/arc/outboundfeeds/rss',
        '{}'::JSONB,
        ARRAY['market', 'exchange', 'regulation', 'technology']::TEXT[],
        TRUE,
        FALSE,
        FALSE
    ),
    (
        'cointelegraph-rss',
        'Cointelegraph RSS',
        'RSS',
        'RSS',
        'https://cointelegraph.com/rss',
        '{}'::JSONB,
        ARRAY['market', 'exchange', 'regulation', 'technology']::TEXT[],
        TRUE,
        FALSE,
        FALSE
    )
ON CONFLICT (source_key) DO NOTHING;
