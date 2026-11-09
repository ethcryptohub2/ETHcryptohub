import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeNewsUrl,
  classifyNewsSentiment,
  fetchNormalizedNews,
  isSafeNewsEndpoint,
  shouldAutoPublishNews,
  tickerSymbolsFromText,
  type NewsSourceAdapterConfig,
} from '../src/services/news-aggregator.js';

const source: NewsSourceAdapterConfig = {
  id: 1,
  sourceKey: 'publisher-feed',
  name: 'Publisher',
  adapter: 'RSS',
  sourceType: 'RSS',
  endpoint: 'https://news.example.org/feed.xml',
  configuration: {},
  allowedCategories: ['market', 'exchange'],
  isTrusted: false,
  autoPublish: false,
};

describe('news provider adapters', () => {
  it('canonicalizes URLs and removes tracking parameters', () => {
    expect(canonicalizeNewsUrl('https://news.example.org/story?utm_source=email&id=42#top'))
      .toEqual({
        originalUrl: 'https://news.example.org/story?id=42',
        canonicalUrl: 'https://news.example.org/story?id=42',
      });
    expect(canonicalizeNewsUrl('http://127.0.0.1/feed')).toBeNull();
    expect(canonicalizeNewsUrl('https://localhost/feed')).toBeNull();
  });

  it('normalizes RSS articles and rejects malformed entries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `<rss><channel><item><guid>article-1</guid><title>Bitcoin gains after launch</title><description>Market update</description><link>https://news.example.org/btc?utm_source=rss</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate><category>market</category></item><item><title>Missing URL</title></item></channel></rss>`,
      { headers: { 'content-type': 'application/rss+xml' } },
    ));
    const articles = await fetchNormalizedNews(source, null, true, fetcher);
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      externalId: 'article-1',
      headline: 'Bitcoin gains after launch',
      originalUrl: 'https://news.example.org/btc',
      canonicalUrl: 'https://news.example.org/btc',
      categoryKey: 'market',
      sentiment: 'BULLISH',
    });
    expect(articles[0]?.publishedAt).toBe('2026-11-06T10:00:00.000Z');
  });

  it('cleans RSS HTML and extracts only safe HTTPS article images', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `<rss><channel><item><title>Bitcoin market update</title><link>https://news.example.org/btc</link><description><![CDATA[<p>Market <strong>story</strong> &amp; details</p><img src="https://images.example.org/btc.jpg">]]></description></item><item><title>Unsafe image</title><link>https://news.example.org/unsafe</link><description><![CDATA[<img src="http://images.example.org/unsafe.jpg">A report]]></description></item></channel></rss>`,
      { headers: { 'content-type': 'application/rss+xml' } },
    ));
    const articles = await fetchNormalizedNews(source, null, true, fetcher);
    expect(articles[0]).toMatchObject({
      description: 'Market story & details',
      imageUrl: 'https://images.example.org/btc.jpg',
    });
    expect(articles[1]).toMatchObject({ description: 'A report', imageUrl: null });
  });

  it('uses configured JSON mappings and source-approved categories', async () => {
    const jsonSource: NewsSourceAdapterConfig = {
      ...source,
      adapter: 'JSON_API',
      sourceType: 'ECONOMIC_CALENDAR',
      endpoint: 'https://calendar.example.org/api',
      allowedCategories: ['economics'],
      configuration: {
        itemsPath: 'data.items',
        mapping: {
          headline: 'title.text',
          description: 'summary',
          url: 'link',
          id: 'key',
          publishedAt: 'published',
          tickers: 'assets',
          category: 'category',
          priority: 'priority',
        },
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [{
        key: 'event-1',
        title: { text: 'Rate decision scheduled' },
        summary: 'Official calendar entry',
        link: 'https://calendar.example.org/events/1',
        published: '2026-11-06T10:00:00Z',
        assets: ['BTC'],
        category: 'market',
        priority: 'breaking',
      }] },
    }), { headers: { 'content-type': 'application/json' } }));
    await expect(fetchNormalizedNews(jsonSource, null, false, fetcher)).resolves.toMatchObject([{
      externalId: 'event-1',
      categoryKey: 'economics',
      sentiment: 'UNAVAILABLE',
      priority: 'BREAKING',
      tickerSymbols: ['BTC'],
    }]);
  });

  it('rejects non-HTTPS provider endpoints and malformed provider payloads', async () => {
    const httpSource = { ...source, endpoint: 'http://news.example.org/feed.xml' };
    await expect(fetchNormalizedNews(httpSource, null, false, vi.fn())).rejects.toThrow('external HTTPS');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<not xml', { status: 200 }));
    await expect(fetchNormalizedNews(source, null, false, fetcher)).rejects.toThrow();
  });

  it('extracts tickers and leaves neutral copy neutral', () => {
    expect(tickerSymbolsFromText('News for $BTC and $ETH today')).toEqual(['BTC', 'ETH']);
    expect(classifyNewsSentiment('Bitcoin market update', 'The report was published today')).toBe('NEUTRAL');
  });

  it('only auto-publishes when both platform and trusted-source controls allow it', () => {
    const enabled = { newsEnabled: true, automaticPublishing: true };
    expect(shouldAutoPublishNews(enabled, { enabled: true, trusted: true, autoPublish: true })).toBe(true);
    expect(shouldAutoPublishNews(enabled, { enabled: true, trusted: false, autoPublish: true })).toBe(false);
    expect(shouldAutoPublishNews({ ...enabled, automaticPublishing: false }, { enabled: true, trusted: true, autoPublish: true })).toBe(false);
    expect(isSafeNewsEndpoint('https://news.example.org/feed')).toBe(true);
    expect(isSafeNewsEndpoint('https://news.example.org/feed?api_key=leaked')).toBe(false);
  });
});
