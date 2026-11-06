import { z } from 'zod';
import type { FuturesMarketSnapshot } from './binance-futures-markets.js';
import type { ScannerConfiguration } from './market-scanner.js';

const BYBIT_BASE_URL = 'https://api.bybit.com';
const BINANCE_BASE_URL = 'https://fapi.binance.com';
const COINGLASS_BASE_URL = 'https://open-api-v4.coinglass.com';
const GLASSNODE_BASE_URL = 'https://api.glassnode.com';
const CRYPTOPANIC_BASE_URL = 'https://cryptopanic.com/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_DURATION_MS = 5 * 60_000;

export type ResearchFeedStatus = 'LIVE' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

export interface ResearchFeed<T> {
  status: ResearchFeedStatus;
  source: string | null;
  updatedAt: string | null;
  reason: string | null;
  data: T | null;
}

export interface MarketResearchSummary {
  derivatives: ResearchFeed<{
    fundingRatePercent: number;
    openInterestChangePercent: number | null;
  }>;
  liquidationHeatmap: ResearchFeed<{
    nearestAbove: { price: number; notional: number } | null;
    nearestBelow: { price: number; notional: number } | null;
    levels: Array<{ price: number; notional: number }>;
  }>;
  onChainFlow: ResearchFeed<{
    exchangeNetflow: number;
    asset: string;
  }>;
  news: ResearchFeed<{
    itemCount: number;
    positiveVotes: number;
    negativeVotes: number;
    stories: Array<{ title: string; url: string; publishedAt: string | null }>;
  }>;
}

export interface MarketResearchKeys {
  glassnode: string | null;
  cryptopanic: string | null;
  coinglass: string | null;
}

export interface MarketResearchRequest {
  symbol: string;
  baseAsset: string;
  exchange: FuturesMarketSnapshot['exchange'];
  timeframe: ScannerConfiguration['timeframe'];
  price: number;
}

export interface MarketResearchProvider {
  getResearch(request: MarketResearchRequest): Promise<MarketResearchSummary>;
}

const bybitEnvelope = z.object({
  retCode: z.literal(0),
  result: z.object({ list: z.array(z.record(z.string(), z.unknown())) }),
});
const coinglassEnvelope = z.object({
  code: z.union([z.literal('0'), z.literal(0)]),
  data: z.object({
    y_axis: z.array(z.union([z.number(), z.string()])),
    liquidation_leverage_data: z.array(z.array(z.union([z.number(), z.string()]))),
  }),
});
const glassnodeRows = z.array(z.object({ t: z.number(), v: z.number() }));
const cryptopanicEnvelope = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    published_at: z.string().nullish(),
    votes: z.object({
      positive: z.number().nullish(),
      negative: z.number().nullish(),
    }).nullish(),
  })),
});

function feed<T>(
  status: ResearchFeedStatus,
  reason: string | null,
  source: string | null = null,
  data: T | null = null,
): ResearchFeed<T> {
  return {
    status,
    source,
    updatedAt: status === 'LIVE' ? new Date().toISOString() : null,
    reason,
    data,
  };
}

function timeframeInterval(timeframe: ScannerConfiguration['timeframe']): string {
  switch (timeframe) {
    case '5m': return '5min';
    case '15m': return '15min';
    case '1h': return '1h';
    case '4h': return '4h';
  }
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function requestJson(
  fetcher: typeof fetch,
  url: URL,
  headers?: HeadersInit,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: headers ?? {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function baseResearch(keys: MarketResearchKeys): MarketResearchSummary {
  return {
    derivatives: feed('UNAVAILABLE', 'Exchange metrics have not been loaded.'),
    liquidationHeatmap: feed(
      keys.coinglass ? 'UNAVAILABLE' : 'NOT_CONFIGURED',
      keys.coinglass ? 'CoinGlass has not returned heatmap data.' : 'CoinGlass API key is not configured.',
    ),
    onChainFlow: feed(
      keys.glassnode ? 'UNAVAILABLE' : 'NOT_CONFIGURED',
      keys.glassnode ? 'Glassnode has not returned exchange-flow data.' : 'Glassnode API key is not configured.',
    ),
    news: feed(
      keys.cryptopanic ? 'UNAVAILABLE' : 'NOT_CONFIGURED',
      keys.cryptopanic ? 'CryptoPanic has not returned news data.' : 'CryptoPanic API key is not configured.',
    ),
  };
}

export class ConfiguredMarketResearchProvider implements MarketResearchProvider {
  private readonly cache = new Map<string, { expiresAt: number; value: MarketResearchSummary }>();

  constructor(
    private readonly keys: MarketResearchKeys,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getResearch(request: MarketResearchRequest): Promise<MarketResearchSummary> {
    const cacheKey = `${request.exchange}:${request.symbol}:${request.timeframe}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const result = baseResearch(this.keys);
    const [derivatives, liquidationHeatmap, onChainFlow, news] = await Promise.all([
      this.getDerivatives(request),
      this.getLiquidationHeatmap(request),
      this.getOnChainFlow(request.baseAsset),
      this.getNews(request.baseAsset),
    ]);
    result.derivatives = derivatives;
    result.liquidationHeatmap = liquidationHeatmap;
    result.onChainFlow = onChainFlow;
    result.news = news;
    this.cache.set(cacheKey, { expiresAt: this.now() + CACHE_DURATION_MS, value: result });
    return result;
  }

  private async getDerivatives(
    request: MarketResearchRequest,
  ): Promise<MarketResearchSummary['derivatives']> {
    try {
      const data = request.exchange === 'BYBIT'
        ? await this.getBybitDerivatives(request)
        : await this.getBinanceDerivatives(request);
      return feed('LIVE', null, `${request.exchange} public funding/open-interest endpoints`, data);
    } catch (error) {
      return feed(
        'UNAVAILABLE',
        `${request.exchange} funding/open-interest data unavailable (${error instanceof Error ? error.message : 'unknown provider error'}).`,
      );
    }
  }

  private async getBybitDerivatives(
    request: MarketResearchRequest,
  ): Promise<NonNullable<MarketResearchSummary['derivatives']['data']>> {
    const fundingUrl = new URL(`${BYBIT_BASE_URL}/v5/market/funding/history`);
    fundingUrl.searchParams.set('category', 'linear');
    fundingUrl.searchParams.set('symbol', request.symbol);
    fundingUrl.searchParams.set('limit', '1');
    const openInterestUrl = new URL(`${BYBIT_BASE_URL}/v5/market/open-interest`);
    openInterestUrl.searchParams.set('category', 'linear');
    openInterestUrl.searchParams.set('symbol', request.symbol);
    openInterestUrl.searchParams.set('intervalTime', timeframeInterval(request.timeframe));
    openInterestUrl.searchParams.set('limit', '2');
    const [fundingBody, interestBody] = await Promise.all([
      this.request(fundingUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' }),
      this.request(openInterestUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' }),
    ]);
    if (!fundingBody.ok || !interestBody.ok) throw new Error(`HTTP ${!fundingBody.ok ? fundingBody.status : interestBody.status}`);
    const [fundingJson, interestJson] = await Promise.all([fundingBody.json(), interestBody.json()]);
    const funding = bybitEnvelope.safeParse(fundingJson);
    const interest = bybitEnvelope.safeParse(interestJson);
    const fundingRate = funding.success ? numberValue(funding.data.result.list[0]?.fundingRate) : null;
    const openInterest = interest.success
      ? interest.data.result.list.map((row) => numberValue(row.openInterest)).filter((value): value is number => value !== null)
      : [];
    if (fundingRate === null) throw new Error('Bybit returned invalid funding data.');
    return {
      fundingRatePercent: fundingRate * 100,
      openInterestChangePercent: openInterest.length >= 2 && openInterest[1] !== 0
        ? ((openInterest[0]! - openInterest[1]!) / openInterest[1]!) * 100
        : null,
    };
  }

  private async getBinanceDerivatives(
    request: MarketResearchRequest,
  ): Promise<NonNullable<MarketResearchSummary['derivatives']['data']>> {
    const fundingUrl = new URL(`${BINANCE_BASE_URL}/fapi/v1/fundingRate`);
    fundingUrl.searchParams.set('symbol', request.symbol);
    fundingUrl.searchParams.set('limit', '1');
    const period = request.timeframe;
    const interestUrl = new URL(`${BINANCE_BASE_URL}/futures/data/openInterestHist`);
    interestUrl.searchParams.set('symbol', request.symbol);
    interestUrl.searchParams.set('period', period);
    interestUrl.searchParams.set('limit', '2');
    const [fundingBody, interestBody] = await Promise.all([
      this.request(fundingUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' }),
      this.request(interestUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: 'no-store' }),
    ]);
    if (!fundingBody.ok || !interestBody.ok) throw new Error(`HTTP ${!fundingBody.ok ? fundingBody.status : interestBody.status}`);
    const [fundingJson, interestJson] = await Promise.all([fundingBody.json(), interestBody.json()]);
    const fundingRows = z.array(z.object({ fundingRate: z.string() })).safeParse(fundingJson);
    const interestRows = z.array(z.object({ sumOpenInterestValue: z.string() })).safeParse(interestJson);
    const fundingRate = fundingRows.success ? numberValue(fundingRows.data[0]?.fundingRate) : null;
    const openInterest = interestRows.success
      ? interestRows.data.map((row) => numberValue(row.sumOpenInterestValue)).filter((value): value is number => value !== null)
      : [];
    if (fundingRate === null) throw new Error('Binance returned invalid funding data.');
    return {
      fundingRatePercent: fundingRate * 100,
      openInterestChangePercent: openInterest.length >= 2 && openInterest[openInterest.length - 2] !== 0
        ? ((openInterest[openInterest.length - 1]! - openInterest[openInterest.length - 2]!) / openInterest[openInterest.length - 2]!) * 100
        : null,
    };
  }

  private async getLiquidationHeatmap(
    request: MarketResearchRequest,
  ): Promise<MarketResearchSummary['liquidationHeatmap']> {
    if (!this.keys.coinglass) return feed('NOT_CONFIGURED', 'CoinGlass API key is not configured.');
    try {
      const url = new URL(`${COINGLASS_BASE_URL}/api/futures/liquidation/heatmap/model1`);
      url.searchParams.set('exchange', 'Binance');
      url.searchParams.set('symbol', request.symbol);
      url.searchParams.set('range', '24h');
      const body = coinglassEnvelope.safeParse(await requestJson(this.request, url, { 'CG-API-KEY': this.keys.coinglass }));
      if (!body.success) throw new Error('CoinGlass returned an invalid heatmap.');
      const levelsByPrice = new Map<number, number>();
      for (const row of body.data.data.liquidation_leverage_data) {
        const yIndex = numberValue(row[1]);
        const notional = numberValue(row[2]);
        if (yIndex === null || notional === null) continue;
        const price = Number.isInteger(yIndex) ? numberValue(body.data.data.y_axis[yIndex]) : null;
        if (price === null || price <= 0 || notional <= 0) continue;
        levelsByPrice.set(price, (levelsByPrice.get(price) ?? 0) + notional);
      }
      const levels = [...levelsByPrice.entries()].map(([price, notional]) => ({ price, notional }));
      if (levels.length === 0) throw new Error('CoinGlass returned no liquidation levels.');
      const above = levels.filter((level) => level.price > request.price).sort((a, b) => a.price - b.price);
      const below = levels.filter((level) => level.price < request.price).sort((a, b) => b.price - a.price);
      return feed('LIVE', null, 'CoinGlass liquidation heatmap (24h)', {
        nearestAbove: above[0] ?? null,
        nearestBelow: below[0] ?? null,
        levels: levels.sort((a, b) => b.notional - a.notional).slice(0, 10),
      });
    } catch (error) {
      return feed('UNAVAILABLE', `CoinGlass heatmap unavailable: ${error instanceof Error ? error.message : 'request failed'}.`);
    }
  }

  private async getOnChainFlow(baseAsset: string): Promise<MarketResearchSummary['onChainFlow']> {
    if (!this.keys.glassnode) return feed('NOT_CONFIGURED', 'Glassnode API key is not configured.');
    const asset = baseAsset.toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(asset)) return feed('UNAVAILABLE', 'Asset is not supported by the Glassnode metric.');
    try {
      const url = new URL(`${GLASSNODE_BASE_URL}/v1/metrics/transactions/transfers_volume_exchanges_net`);
      url.searchParams.set('a', asset);
      url.searchParams.set('i', '24h');
      url.searchParams.set('api_key', this.keys.glassnode);
      const body = glassnodeRows.safeParse(await requestJson(this.request, url));
      const latest = body.success ? body.data.at(-1) : null;
      if (!latest || !Number.isFinite(latest.v)) throw new Error('Glassnode returned no exchange-netflow point.');
      return feed('LIVE', null, 'Glassnode exchange netflow (24h)', {
        exchangeNetflow: latest.v,
        asset,
      });
    } catch (error) {
      return feed('UNAVAILABLE', `Glassnode exchange-flow metric unavailable: ${error instanceof Error ? error.message : 'request failed'}.`);
    }
  }

  private async getNews(baseAsset: string): Promise<MarketResearchSummary['news']> {
    if (!this.keys.cryptopanic) return feed('NOT_CONFIGURED', 'CryptoPanic API key is not configured.');
    try {
      const url = new URL(`${CRYPTOPANIC_BASE_URL}/posts/`);
      url.searchParams.set('auth_token', this.keys.cryptopanic);
      url.searchParams.set('currencies', baseAsset.toUpperCase());
      url.searchParams.set('kind', 'news');
      const body = cryptopanicEnvelope.safeParse(await requestJson(this.request, url));
      if (!body.success) throw new Error('CryptoPanic returned an invalid news response.');
      const stories = body.data.results.slice(0, 5).map((story) => ({
        title: story.title,
        url: story.url,
        publishedAt: story.published_at ?? null,
      }));
      return feed('LIVE', null, 'CryptoPanic news and community votes', {
        itemCount: body.data.results.length,
        positiveVotes: body.data.results.reduce((sum, item) => sum + (item.votes?.positive ?? 0), 0),
        negativeVotes: body.data.results.reduce((sum, item) => sum + (item.votes?.negative ?? 0), 0),
        stories,
      });
    } catch (error) {
      return feed('UNAVAILABLE', `CryptoPanic news unavailable: ${error instanceof Error ? error.message : 'request failed'}.`);
    }
  }
}

export function emptyMarketResearch(keys: MarketResearchKeys = {
  glassnode: null,
  cryptopanic: null,
  coinglass: null,
}): MarketResearchSummary {
  return baseResearch(keys);
}
