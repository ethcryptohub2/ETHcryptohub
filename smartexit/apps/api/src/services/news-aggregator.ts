import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export type NewsSourceType =
  | 'CRYPTO_API'
  | 'RSS'
  | 'EXCHANGE_ANNOUNCEMENT'
  | 'ONCHAIN_ACTIVITY'
  | 'ECONOMIC_CALENDAR'
  | 'JSON_API';

export type NewsAdapter = 'CRYPTOPANIC' | 'RSS' | 'JSON_API';
export type NewsSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNAVAILABLE';
export type NewsPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'BREAKING';

export interface NewsSourceAdapterConfig {
  id: number;
  sourceKey: string;
  name: string;
  adapter: NewsAdapter;
  sourceType: NewsSourceType;
  endpoint: string;
  configuration: Record<string, unknown>;
  allowedCategories: string[];
  isTrusted: boolean;
  autoPublish: boolean;
}

export interface IncomingNewsArticle {
  externalId: string;
  headline: string;
  description: string;
  imageUrl: string | null;
  originalUrl: string;
  canonicalUrl: string;
  publishedAt: string | null;
  tickerSymbols: string[];
  categoryKey: string;
  sentiment: NewsSentiment;
  priority: NewsPriority;
}

export function shouldAutoPublishNews(
  settings: { newsEnabled: boolean; automaticPublishing: boolean },
  source: { enabled: boolean; trusted: boolean; autoPublish: boolean },
): boolean {
  return settings.newsEnabled && settings.automaticPublishing && source.enabled && source.trusted && source.autoPublish;
}

const CATEGORY_KEYS = new Set([
  'market',
  'exchange',
  'onchain',
  'economics',
  'regulation',
  'technology',
]);
const TRACKING_PARAMETERS = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|.*(?:api.?key|token|secret|signature|auth).*)$/i;
const MAX_RESPONSE_BYTES = 3_000_000;
const MAX_ARTICLES_PER_SOURCE = 250;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  trimValues: true,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  if (isPlainObject(value) && typeof value['#text'] === 'string') return value['#text'].trim();
  return '';
}

function getPath(value: unknown, path: unknown): unknown {
  if (typeof path !== 'string' || path.length > 200) return undefined;
  return path.split('.').reduce<unknown>((current, key) =>
    isPlainObject(current) ? current[key] : undefined, value);
}

function getStringField(item: unknown, mapping: Record<string, unknown>, key: string): string {
  return text(getPath(item, mapping[key]));
}

function safeHttpsUrl(value: string, allowSensitiveQuery = false): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !host ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      isIP(host.replace(/^\[|\]$/g, '')) !== 0
    ) return null;
    if (!allowSensitiveQuery && [...url.searchParams.keys()].some((key) => TRACKING_PARAMETERS.test(key))) return null;
    return url;
  } catch {
    return null;
  }
}

export function isSafeNewsEndpoint(value: string): boolean {
  return safeHttpsUrl(value) !== null;
}

export function canonicalizeNewsUrl(value: string): { originalUrl: string; canonicalUrl: string } | null {
  const parsed = safeHttpsUrl(value, true);
  if (!parsed) return null;
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const safeUrl = parsed.toString();
  return { originalUrl: safeUrl, canonicalUrl: safeUrl };
}

function parsePublishedAt(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const hexadecimal = code[1]?.toLowerCase() === 'x';
    const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff
      ? String.fromCodePoint(number)
      : entity;
  });
}

function cleanNewsDescription(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\b[^>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20_000);
}

function imageUrlFromValue(value: unknown): string {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const url = imageUrlFromValue(candidate);
      if (url) return url;
    }
    return '';
  }
  if (typeof value === 'string') return value.trim();
  if (!isPlainObject(value)) return '';
  for (const key of ['@_url', '@_href', 'url', 'href', '#text']) {
    const url = text(value[key]);
    if (url) return url;
  }
  return '';
}

function imageUrlFromMarkup(value: string): string {
  const image = value.match(/<img\b[^>]*>/i)?.[0];
  if (!image) return '';
  const source = image.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return decodeHtmlEntities(source?.[1] ?? source?.[2] ?? source?.[3] ?? '').trim();
}

function categoryFor(source: NewsSourceAdapterConfig, itemCategory: string): string {
  const normalized = itemCategory.toLowerCase().replace(/[^a-z]/g, '');
  const aliases: Record<string, string> = {
    bitcoin: 'market',
    cryptocurrency: 'market',
    exchangeannouncement: 'exchange',
    announcement: 'exchange',
    whale: 'onchain',
    onchainactivity: 'onchain',
    economiccalendar: 'economics',
    macro: 'economics',
    regulation: 'regulation',
    technology: 'technology',
  };
  const candidate = aliases[normalized] ?? normalized;
  if (CATEGORY_KEYS.has(candidate) && source.allowedCategories.includes(candidate)) return candidate;
  return source.allowedCategories.find((category) => CATEGORY_KEYS.has(category)) ?? 'market';
}

export function extractTickerSymbols(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (isPlainObject(item)) return [item.code, item.symbol, item.ticker].filter((part) => typeof part === 'string') as string[];
        return [];
      })
    : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  return [...new Set(candidates
    .map((candidate) => candidate.toUpperCase().replace(/^\$/, '').replace(/USDT$/, ''))
    .filter((ticker) => /^[A-Z0-9]{2,12}$/.test(ticker)))].slice(0, 30);
}

export function tickerSymbolsFromText(value: string): string[] {
  return [...new Set([...value.matchAll(/\$([A-Z][A-Z0-9]{1,11})\b/g)].map((match) => match[1]!))].slice(0, 30);
}

export function classifyNewsSentiment(headline: string, description = ''): NewsSentiment {
  const positive = /\b(approval|approved|bullish|gain|gains|growth|high|launch|partnership|rise|surge|win|wins)\b/gi;
  const negative = /\b(ban|bearish|crash|decline|hack|lawsuit|loss|losses|low|reject|rejected|risk|selloff|slump)\b/gi;
  const content = `${headline} ${description}`;
  const positiveCount = [...content.matchAll(positive)].length;
  const negativeCount = [...content.matchAll(negative)].length;
  if (positiveCount === negativeCount) return 'NEUTRAL';
  return positiveCount > negativeCount ? 'BULLISH' : 'BEARISH';
}

function explicitPriority(value: unknown): NewsPriority {
  const normalized = text(value).toUpperCase();
  return normalized === 'BREAKING' || normalized === 'HIGH' || normalized === 'LOW'
    ? normalized
    : 'NORMAL';
}

function normalizeItem(
  item: unknown,
  source: NewsSourceAdapterConfig,
  mapping: Record<string, unknown>,
  sentimentEnabled: boolean,
): IncomingNewsArticle | null {
  if (!isPlainObject(item)) return null;
  const headline = getStringField(item, mapping, 'headline').slice(0, 500);
  const link = getStringField(item, mapping, 'url');
  const canonical = canonicalizeNewsUrl(link);
  if (!headline || !canonical) return null;
  const rawDescription = getStringField(item, mapping, 'description');
  const imageCandidate = imageUrlFromValue(getPath(item, mapping.imageUrl)) || imageUrlFromMarkup(rawDescription);
  const imageUrl = imageCandidate ? safeHttpsUrl(decodeHtmlEntities(imageCandidate), true)?.toString() ?? null : null;
  const description = cleanNewsDescription(rawDescription);
  const externalIdValue = getStringField(item, mapping, 'id');
  const externalId = (externalIdValue || createHash('sha256').update(canonical.canonicalUrl).digest('hex')).slice(0, 300);
  const mappedTickers = getPath(item, mapping.tickers);
  const tickerSymbols = extractTickerSymbols(mappedTickers);
  if (tickerSymbols.length === 0) tickerSymbols.push(...tickerSymbolsFromText(`${headline} ${description}`));
  const dateValue = getPath(item, mapping.publishedAt);
  const itemCategory = getStringField(item, mapping, 'category');
  const sentimentValue = getStringField(item, mapping, 'sentiment').toUpperCase();
  const sentiment: NewsSentiment = sentimentEnabled
    ? sentimentValue === 'BULLISH' || sentimentValue === 'BEARISH' || sentimentValue === 'NEUTRAL'
      ? sentimentValue
      : classifyNewsSentiment(headline, description)
    : 'UNAVAILABLE';
  return {
    externalId,
    headline,
    description,
    imageUrl,
    originalUrl: canonical.originalUrl,
    canonicalUrl: canonical.canonicalUrl,
    publishedAt: parsePublishedAt(dateValue),
    tickerSymbols,
    categoryKey: categoryFor(source, itemCategory || source.sourceType),
    sentiment,
    priority: explicitPriority(getPath(item, mapping.priority)),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function atomUrl(item: unknown): string {
  if (!isPlainObject(item)) return '';
  const link = item.link;
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    const alternate = link.find((entry) => isPlainObject(entry) && entry['@_rel'] === 'alternate') ?? link[0];
    return atomUrl({ link: alternate });
  }
  return isPlainObject(link) ? text(link['@_href']) || text(link['#text']) : '';
}

function parseRssItems(body: string): unknown[] {
  const parsed: unknown = xmlParser.parse(body);
  if (!isPlainObject(parsed)) return [];
  const rss = parsed.rss;
  if (isPlainObject(rss) && isPlainObject(rss.channel)) {
    return asArray(rss.channel.item);
  }
  const feed = parsed.feed;
  return isPlainObject(feed) ? asArray(feed.entry) : [];
}

function mapRssItem(item: unknown): Record<string, unknown> | null {
  if (!isPlainObject(item)) return null;
  const id = item.guid ?? item.id;
  const url = item.link ?? item.url;
  return {
    id: isPlainObject(id) ? id['#text'] : id,
    headline: item.title,
    description: item.description ?? item.summary ?? item.content,
    imageUrl: item.enclosure ?? item['media:content'] ?? item['media:thumbnail'],
    url: typeof url === 'string' ? url : atomUrl(item),
    publishedAt: item.pubDate ?? item.published ?? item.updated,
    tickers: item.tickers ?? item.symbols,
    category: item.category,
    sentiment: item.sentiment,
    priority: item.priority,
  };
}

function getItemsFromJson(body: unknown, path: unknown): unknown[] {
  const value = typeof path === 'string' && path ? getPath(body, path) : body;
  return asArray(value).slice(0, MAX_ARTICLES_PER_SOURCE);
}

function configMapping(source: NewsSourceAdapterConfig): Record<string, unknown> {
  const mapping = source.configuration.mapping;
  return isPlainObject(mapping) ? mapping : {};
}

function defaultMapping(source: NewsSourceAdapterConfig): Record<string, unknown> {
  if (source.adapter === 'CRYPTOPANIC') {
    return {
      headline: 'title',
      description: 'title',
      url: 'url',
      id: 'id',
      publishedAt: 'published_at',
      tickers: 'currencies',
      priority: 'kind',
      imageUrl: 'imageUrl',
    };
  }
  if (source.adapter === 'RSS') {
    return {
      headline: 'headline',
      description: 'description',
      url: 'url',
      id: 'id',
      publishedAt: 'publishedAt',
      tickers: 'tickers',
      category: 'category',
      sentiment: 'sentiment',
      priority: 'priority',
      imageUrl: 'imageUrl',
    };
  }
  return {
    headline: 'headline',
    description: 'description',
    url: 'url',
    id: 'id',
    publishedAt: 'publishedAt',
    tickers: 'tickers',
    category: 'category',
    sentiment: 'sentiment',
    priority: 'priority',
    imageUrl: 'imageUrl',
  };
}

async function fetchBody(
  endpoint: string,
  credential: string | null,
  adapter: NewsAdapter,
  configuration: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<unknown> {
  const url = safeHttpsUrl(endpoint);
  if (!url) throw new Error('Source endpoint must be an external HTTPS URL.');
  if (adapter === 'CRYPTOPANIC') {
    if (!credential) throw new Error('CryptoPanic requires a configured API credential.');
    url.searchParams.set('auth_token', credential);
  }
  const headers = new Headers({
    Accept: adapter === 'RSS' ? 'application/rss+xml, application/atom+xml, application/xml, text/xml' : 'application/json',
    'User-Agent': 'ETHcryptohub-NewsAggregator/1.0',
  });
  if (adapter === 'JSON_API' && credential) {
    const queryParameter = text(configuration.credentialQueryParameter);
    if (queryParameter) {
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(queryParameter)) throw new Error('Configured API key query parameter is invalid.');
      url.searchParams.set(queryParameter, credential);
    } else {
      const header = text(configuration.credentialHeader) || 'Authorization';
      const prefix = text(configuration.credentialPrefix) || 'Bearer';
      if (!/^[A-Za-z0-9-]{1,60}$/.test(header) || /^(host|content-length|cookie|set-cookie)$/i.test(header)) {
        throw new Error('Configured API credential header is invalid.');
      }
      headers.set(header, prefix ? `${prefix} ${credential}` : credential);
    }
  }
  const response = await fetcher(url, {
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('Provider response exceeded the size limit.');
  if (!response.body) throw new Error('Provider response body is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Provider response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  return adapter === 'RSS' ? body : JSON.parse(body) as unknown;
}

export async function fetchNormalizedNews(
  source: NewsSourceAdapterConfig,
  credential: string | null,
  sentimentEnabled: boolean,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<IncomingNewsArticle[]> {
  const body = await fetchBody(source.endpoint, credential, source.adapter, source.configuration, fetcher);
  const mapping = { ...defaultMapping(source), ...configMapping(source) };
  const rawItems = source.adapter === 'RSS'
    ? parseRssItems(String(body)).map(mapRssItem)
    : getItemsFromJson(
        body,
        source.configuration.itemsPath ?? (source.adapter === 'CRYPTOPANIC' ? 'results' : undefined),
      );
  return rawItems
    .slice(0, MAX_ARTICLES_PER_SOURCE)
    .map((item) => normalizeItem(item, source, mapping, sentimentEnabled))
    .filter((item): item is IncomingNewsArticle => item !== null);
}
