import { z } from 'zod';

const binanceDocs = 'https://developers.binance.com/en/docs/catalog/advanced-trading-alpha-trading/api/rest-api/market-data';
const alphaEndpoints = {
  tokens: '/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
  markets: '/bapi/defi/v1/public/alpha-trade/get-exchange-info',
  ticker: '/bapi/defi/v1/public/alpha-trade/ticker',
  depth: '/bapi/defi/v1/public/alpha-trade/fullDepth',
  candles: '/bapi/defi/v1/public/alpha-trade/klines',
} as const;

type Endpoint = keyof typeof alphaEndpoints;
type SourceStatus = 'DISABLED' | 'AVAILABLE' | 'UNAVAILABLE';

export type AlphaObservation = {
  id: string; symbol: string; name: string; chain: string; contract: string;
  market: string | null; price: number | null; quoteVolume24h: number | null;
  volumeChangePercent: number | null; momentumPercent: number | null;
  liquidity: 'VERIFIED_DEPTH' | 'UNAVAILABLE';
  bidDepthQuote: number | null; askDepthQuote: number | null;
  flows: null; holderConcentration: null; contractRisk: null; campaigns: null; sentiment: null;
  xActivity: null; youtubeActivity: null; engagementAnomaly: null; riskScore: null;
  signalStatus: 'OBSERVATION_ONLY'; verifiedAt: string | null; sourceLinks: string[];
};

export type AlphaSnapshot = {
  checkedAt: string | null;
  rows: AlphaObservation[];
  sources: { id: string; label: string; status: SourceStatus; url: string | null;
    checkedAt: string | null; detail: string }[];
};

const labels: Record<Endpoint, string> = {
  tokens: 'Alpha token registry',
  markets: 'Alpha exchange information',
  ticker: 'Alpha 24-hour ticker',
  depth: 'Alpha order-book depth',
  candles: 'Alpha closed daily candles',
};
const unavailableSources = [
  ['flows', 'Wallet and exchange flow attribution'],
  ['holders', 'Holder concentration'],
  ['risk', 'Contract risk'],
  ['campaigns', 'Official campaign evidence'],
  ['news', 'News and sentiment'],
  ['x', 'X activity'],
  ['youtube', 'YouTube activity'],
  ['engagement', 'Community engagement anomaly evidence'],
] as const;

export function disabledAlphaSnapshot(): AlphaSnapshot {
  return {
    checkedAt: null, rows: [],
    sources: [
      ...Object.entries(labels).map(([id, label]) => ({ id, label, status: 'DISABLED' as const,
        url: binanceDocs, checkedAt: null, detail: 'Public acquisition awaits separate approval.' })),
      ...unavailableSources.map(([id, label]) => ({ id, label, status: 'UNAVAILABLE' as const,
        url: null, checkedAt: null, detail: 'No approved, verified source is configured.' })),
    ],
  };
}

const alphaId = z.string().regex(/^ALPHA_\d{1,12}$/);
const stableQuote = z.enum(['USDT', 'USDC']);
const tokenSchema = z.object({
  alphaId, chainName: z.string().trim().min(1).max(40),
  contractAddress: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
  name: z.string().trim().min(1).max(100), symbol: z.string().trim().min(1).max(30),
  offline: z.boolean().optional(),
});
const marketsSchema = z.object({
  symbols: z.array(z.object({ symbol: z.string(), status: z.string(), baseAsset: z.string(),
    quoteAsset: z.string() })).max(5000),
});
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(40).transform(Number).pipe(z.number().finite());
const timestamp = z.number().int().positive().safe();
const candleTimestamp = z.union([timestamp, z.string().regex(/^\d{1,16}$/).transform(Number).pipe(timestamp)]);
const tickerSchema = z.object({ symbol: z.string(), lastPrice: decimal.pipe(z.number().positive()),
  quoteVolume: decimal.pipe(z.number().nonnegative()), priceChangePercent: decimal, closeTime: timestamp });
const level = z.tuple([decimal.pipe(z.number().positive()), decimal.pipe(z.number().positive())]);
const depthSchema = z.object({ symbol: z.string(), E: timestamp, lastUpdateId: timestamp,
  bids: z.array(level).min(1).max(5), asks: z.array(level).min(1).max(5) });

const dailyMs = 86_400_000;
function dailyVolumeChange(body: unknown, now: number) {
  if (!Array.isArray(body) || body.length < 2 || body.length > 3) return null;
  const closed = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length !== 12) return null;
    const open = candleTimestamp.safeParse(row[0]), close = candleTimestamp.safeParse(row[6]);
    const volume = decimal.safeParse(row[7]);
    if (!open.success || !close.success || !volume.success || volume.data < 0 ||
        open.data % dailyMs !== 0 || close.data !== open.data + dailyMs - 1) return null;
    if (close.data < now) closed.push({ close: close.data, volume: volume.data });
  }
  const previous = closed.at(-2), latest = closed.at(-1);
  if (!previous || !latest || latest.close !== Math.floor(now / dailyMs) * dailyMs - 1 ||
      latest.close - previous.close !== dailyMs || previous.volume <= 0) return null;
  const change = 100 * (latest.volume / previous.volume - 1);
  return Number.isFinite(change) ? change : null;
}

function recent(at: number, now: number, maxAge: number) {
  return at <= now && now - at <= maxAge;
}

class AlphaReadError extends Error {}
const envelope = z.object({ success: z.literal(true), code: z.literal('000000'), data: z.unknown() });
const bodyLimit = 2 * 1024 * 1024;
export const alphaMaxRequests = 8;

export async function acquireAlphaSnapshot(options: {
  approved: boolean; tokenIds: readonly string[]; transport: typeof fetch;
  signal?: AbortSignal; now?: () => number;
}): Promise<AlphaSnapshot> {
  const snapshot = disabledAlphaSnapshot();
  if (!options.approved) return snapshot;
  const ids = z.array(alphaId).max(2).parse(options.tokenIds);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Alpha token IDs.');
  const now = options.now ?? Date.now;
  const runDeadline = AbortSignal.any([AbortSignal.timeout(12_000), ...(options.signal ? [options.signal] : [])]);

  async function request(endpoint: Endpoint, params?: Record<string, string>) {
    runDeadline.throwIfAborted();
    const url = new URL(alphaEndpoints[endpoint], 'https://www.binance.com');
    if (params) url.search = new URLSearchParams(params).toString();
    const signal = AbortSignal.any([runDeadline, AbortSignal.timeout(3000)]);
    let response: Response;
    try {
      response = await options.transport(url, {
        method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json' }, signal,
      });
    } catch {
      throw new AlphaReadError(signal.aborted ? 'Provider request timed out or was cancelled.' : 'Provider request failed.');
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new AlphaReadError(`Provider stopped acquisition at HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > bodyLimit) throw new AlphaReadError('Provider response exceeded the byte cap.');
        chunks.push(chunk.value);
      }
      signal.throwIfAborted();
      return envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).data;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function read<T>(endpoint: Endpoint, parse: (data: unknown) => T, params?: Record<string, string>) {
    const source = snapshot.sources.find(item => item.id === endpoint)!;
    try {
      const result = parse(await request(endpoint, params));
      source.status = 'AVAILABLE';
      source.checkedAt = new Date(now()).toISOString();
      source.detail = 'Last requested response passed validation.';
      return result;
    } catch (error) {
      source.status = 'UNAVAILABLE';
      source.checkedAt = new Date(now()).toISOString();
      source.detail = error instanceof AlphaReadError ? error.message : 'Provider response failed validation or acquisition timed out.';
      throw new AlphaReadError(source.detail);
    }
  }

  try {
    const tokens = await read('tokens', data => {
      const tokenRows = z.array(tokenSchema).max(2500).parse(data);
      if (new Set(tokenRows.map(token => token.alphaId)).size !== tokenRows.length) throw new Error('Ambiguous registry.');
      return tokenRows.filter(token => !token.offline);
    });
    snapshot.rows = tokens.map(token => ({
      id: token.alphaId, symbol: token.symbol, name: token.name, chain: token.chainName, contract: token.contractAddress,
      market: null, price: null, quoteVolume24h: null, volumeChangePercent: null, momentumPercent: null,
      liquidity: 'UNAVAILABLE', bidDepthQuote: null, askDepthQuote: null,
      flows: null, holderConcentration: null, contractRisk: null, campaigns: null, sentiment: null,
      xActivity: null, youtubeActivity: null, engagementAnomaly: null, riskScore: null,
      signalStatus: 'OBSERVATION_ONLY', verifiedAt: null, sourceLinks: [binanceDocs],
    }));
    const markets = await read('markets', data => marketsSchema.parse(data).symbols);
    const pairs = new Map<string, string>();
    for (const { symbol, status, baseAsset, quoteAsset } of markets) {
      if (status !== 'TRADING' || !alphaId.safeParse(baseAsset).success || !stableQuote.safeParse(quoteAsset).success ||
          symbol !== baseAsset + quoteAsset) continue;
      if (!pairs.has(baseAsset) || quoteAsset === 'USDT') pairs.set(baseAsset, symbol);
    }
    for (const row of snapshot.rows) row.market = pairs.get(row.id) ?? null;
    for (const id of ids) {
      const row = snapshot.rows.find(item => item.id === id);
      const symbol = row?.market;
      if (!row || !symbol) continue;
      const ticker = await read('ticker', data => {
        const quote = tickerSchema.parse(data);
        if (quote.symbol !== symbol || !recent(quote.closeTime, now(), 60_000)) throw new Error('stale or mismatched ticker');
        return quote;
      }, { symbol });
      Object.assign(row, { price: ticker.lastPrice, momentumPercent: ticker.priceChangePercent,
        quoteVolume24h: ticker.quoteVolume, verifiedAt: new Date(ticker.closeTime).toISOString() });
      await read('depth', data => {
        const book = depthSchema.parse(data);
        if (book.symbol !== symbol || !recent(book.E, now(), 10_000)) throw new Error('stale or mismatched depth');
        const bids = book.bids.map(([price]) => price);
        const asks = book.asks.map(([price]) => price);
        if (bids.some((price, i) => i > 0 && price >= bids[i - 1]!) ||
            asks.some((price, i) => i > 0 && price <= asks[i - 1]!) || bids[0]! >= asks[0]!) throw new Error('invalid order book');
        const sum = (levels: [number, number][]) => levels.reduce((acc, [price, quantity]) => acc + price * quantity, 0);
        const bidDepthQuote = sum(book.bids), askDepthQuote = sum(book.asks);
        if (![bidDepthQuote, askDepthQuote].every(Number.isFinite)) throw new Error('invalid depth totals');
        Object.assign(row, { liquidity: 'VERIFIED_DEPTH', bidDepthQuote, askDepthQuote,
          verifiedAt: new Date(Math.min(ticker.closeTime, book.E)).toISOString() });
      }, { symbol, limit: '5' });
      row.volumeChangePercent = await read('candles', data => {
        const change = dailyVolumeChange(data, now());
        if (change === null) throw new Error('daily candle evidence unavailable');
        return change;
      }, { symbol, interval: '1d', limit: '3' });
    }
  } catch {
    // One denied or failed request ends the batch. Retain only fields already verified.
  }
  for (const source of snapshot.sources) {
    if (source.status === 'DISABLED') {
      source.status = 'UNAVAILABLE';
      source.detail = 'No validated observation was collected in this bounded run.';
    }
  }
  snapshot.checkedAt = new Date(now()).toISOString();
  return snapshot;
}
