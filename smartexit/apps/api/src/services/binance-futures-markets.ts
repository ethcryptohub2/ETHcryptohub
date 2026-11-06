import { z } from 'zod';

const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const BYBIT_BASE_URL = 'https://api.bybit.com';
const CACHE_DURATION_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export async function fetchWithBackoff(
  request: typeof fetch,
  input: string | URL | Request,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await request(input, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      continue;
    }
    if (response.ok) return response;
    lastError = new Error(`HTTP ${response.status}`);
    if (![408, 429].includes(response.status) && response.status < 500) break;
    if (attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(2_000, retryAfter)
        : 200 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Public exchange request failed.');
}

const exchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string().min(1),
      status: z.string(),
      contractType: z.string(),
      baseAsset: z.string().min(1),
      quoteAsset: z.string().min(1),
      onboardDate: z.number().int().nonnegative().optional(),
    }),
  ),
});

const tickerSchema = z.array(
  z.object({
    symbol: z.string().min(1),
    lastPrice: z.string().regex(/^\d+(?:\.\d+)?$/),
    priceChangePercent: z.string().regex(/^-?\d+(?:\.\d+)?$/),
    quoteVolume: z.string().regex(/^\d+(?:\.\d+)?$/),
    count: z.number().int().nonnegative(),
  }),
);

const bybitTickersSchema = z.object({
  retCode: z.literal(0),
  result: z.object({
    list: z.array(z.object({
      symbol: z.string().min(1),
      lastPrice: z.string(),
      price24hPcnt: z.string(),
      turnover24h: z.string(),
    })),
  }),
});

const bybitInstrumentsSchema = z.object({
  retCode: z.literal(0),
  result: z.object({
    nextPageCursor: z.string().optional(),
    list: z.array(z.object({
      symbol: z.string().min(1),
      status: z.string(),
      contractType: z.string(),
      baseCoin: z.string().min(1),
      quoteCoin: z.string().min(1),
    })),
  }),
});

export interface BinanceFuturesSymbol {
  symbol: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  lastPrice: number | null;
  priceChangePercent24h: number | null;
  quoteVolume24h: number;
  tradeCount24h: number;
}

export interface BinanceContractMetadata {
  symbol: string;
  status: string;
  contractType: 'PERPETUAL';
  baseAsset: string;
  quoteAsset: 'USDT';
  onboardDate: number | null;
}

export function parseBinanceUsdtPerpetuals(body: unknown): BinanceContractMetadata[] {
  const parsed = exchangeInfoSchema.safeParse(body);
  if (!parsed.success) throw new BinanceMarketDataError('Binance returned invalid exchange information.');
  return parsed.data.symbols
    .filter((contract) =>
      contract.contractType === 'PERPETUAL' &&
      contract.quoteAsset === 'USDT' &&
      /^[\p{L}\p{N}]{2,30}$/u.test(contract.symbol) &&
      /^[\p{L}\p{N}]{1,20}$/u.test(contract.baseAsset) &&
      contract.symbol === `${contract.baseAsset}${contract.quoteAsset}`,
    )
    .map((contract) => ({
      symbol: contract.symbol,
      status: contract.status,
      contractType: 'PERPETUAL',
      baseAsset: contract.baseAsset,
      quoteAsset: 'USDT',
      onboardDate: contract.onboardDate ?? null,
    }));
}

export async function fetchBinanceUsdtPerpetuals(
  request: typeof fetch = globalThis.fetch,
): Promise<BinanceContractMetadata[]> {
  try {
    const response = await fetchWithBackoff(request, `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`);
    return parseBinanceUsdtPerpetuals(await response.json());
  } catch (error) {
    if (error instanceof BinanceMarketDataError) throw error;
    throw new BinanceMarketDataError('Binance exchange information is temporarily unavailable.');
  }
}

export interface FuturesMarketSnapshot {
  exchange: 'BINANCE' | 'BYBIT';
  market: 'USDⓈ-M FUTURES' | 'USDT LINEAR PERPETUALS';
  source: string;
  updatedAt: string;
  symbols: BinanceFuturesSymbol[];
}

export interface FuturesMarketsProvider {
  list(): Promise<FuturesMarketSnapshot>;
}

export class BinanceMarketDataError extends Error {
  constructor(message = 'Live public futures market data is temporarily unavailable.') {
    super(message);
    this.name = 'BinanceMarketDataError';
  }
}

export class BinanceFuturesMarketsService implements FuturesMarketsProvider {
  private cached: { expiresAt: number; snapshot: FuturesMarketSnapshot } | null = null;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<FuturesMarketSnapshot> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.snapshot;

    try {
      const [exchangeResponse, tickerResponse] = await Promise.all([
        fetchWithBackoff(this.request, `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`),
        fetchWithBackoff(this.request, `${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/24hr`),
      ]);

      const [exchangeBody, tickerBody] = await Promise.all([exchangeResponse.json(), tickerResponse.json()]);
      let eligibleContracts: BinanceContractMetadata[];
      try {
        eligibleContracts = parseBinanceUsdtPerpetuals(exchangeBody).filter((contract) => contract.status === 'TRADING');
      } catch {
        throw new BinanceMarketDataError('Binance returned invalid public futures market data.');
      }
      const tickerData = tickerSchema.safeParse(tickerBody);
      if (!tickerData.success) {
        throw new BinanceMarketDataError('Binance returned invalid public futures market data.');
      }

      const tickers = new Map(tickerData.data.map((ticker) => [ticker.symbol, ticker]));
      const symbols = eligibleContracts
        .map((contract) => {
          const ticker = tickers.get(contract.symbol);
          if (!ticker) {
            return {
              symbol: contract.symbol,
              contractType: contract.contractType,
              baseAsset: contract.baseAsset,
              quoteAsset: contract.quoteAsset,
              lastPrice: null,
              priceChangePercent24h: null,
              quoteVolume24h: 0,
              tradeCount24h: 0,
            };
          }
          return {
            symbol: contract.symbol,
            contractType: contract.contractType,
            baseAsset: contract.baseAsset,
            quoteAsset: contract.quoteAsset,
            lastPrice: Number(ticker.lastPrice),
            priceChangePercent24h: Number(ticker.priceChangePercent),
            quoteVolume24h: Number(ticker.quoteVolume),
            tradeCount24h: ticker.count,
          };
        })
        .sort(
          (left, right) =>
            left.quoteAsset.localeCompare(right.quoteAsset) ||
            right.quoteVolume24h - left.quoteVolume24h ||
            left.symbol.localeCompare(right.symbol),
        );

      if (symbols.length === 0) throw new BinanceMarketDataError('Binance returned no active futures markets.');

      const snapshot: FuturesMarketSnapshot = {
        exchange: 'BINANCE',
        market: 'USDⓈ-M FUTURES',
        source: `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo and /fapi/v1/ticker/24hr`,
        updatedAt: new Date(this.now()).toISOString(),
        symbols,
      };
      this.cached = { expiresAt: this.now() + CACHE_DURATION_MS, snapshot };
      return snapshot;
    } catch (error) {
      if (error instanceof BinanceMarketDataError) throw error;
      throw new BinanceMarketDataError('Binance public futures market data is temporarily unavailable.');
    }
  }
}

export class BybitLinearFuturesMarketsService implements FuturesMarketsProvider {
  private cached: { expiresAt: number; snapshot: FuturesMarketSnapshot } | null = null;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<FuturesMarketSnapshot> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.snapshot;
    try {
      const [instrumentsResponse, tickersResponse] = await Promise.all([
        fetchWithBackoff(this.request, `${BYBIT_BASE_URL}/v5/market/instruments-info?category=linear&limit=1000`),
        fetchWithBackoff(this.request, `${BYBIT_BASE_URL}/v5/market/tickers?category=linear`),
      ]);
      const [instrumentsBody, tickersBody] = await Promise.all([
        instrumentsResponse.json(),
        tickersResponse.json(),
      ]);
      const instruments = bybitInstrumentsSchema.safeParse(instrumentsBody);
      const tickers = bybitTickersSchema.safeParse(tickersBody);
      if (!instruments.success || !tickers.success || instruments.data.result.nextPageCursor) {
        throw new BinanceMarketDataError('Bybit returned incomplete public futures market data.');
      }
      const tickerBySymbol = new Map(tickers.data.result.list.map((ticker) => [ticker.symbol, ticker]));
      const symbols = instruments.data.result.list
        .filter((instrument) =>
          instrument.status === 'Trading' &&
          instrument.contractType === 'LinearPerpetual' &&
          instrument.quoteCoin === 'USDT'
        )
        .map((instrument) => {
          const ticker = tickerBySymbol.get(instrument.symbol);
          const lastPrice = Number(ticker?.lastPrice);
          const priceChangePercent24h = Number(ticker?.price24hPcnt) * 100;
          const quoteVolume24h = Number(ticker?.turnover24h);
          return {
            symbol: instrument.symbol,
            contractType: 'PERPETUAL',
            baseAsset: instrument.baseCoin,
            quoteAsset: instrument.quoteCoin,
            lastPrice: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null,
            priceChangePercent24h: Number.isFinite(priceChangePercent24h) ? priceChangePercent24h : null,
            quoteVolume24h: Number.isFinite(quoteVolume24h) && quoteVolume24h >= 0 ? quoteVolume24h : 0,
            tradeCount24h: 0,
          };
        })
        .sort((left, right) =>
          right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol)
        );
      if (symbols.length === 0) {
        throw new BinanceMarketDataError('Bybit returned no eligible USDT perpetual markets.');
      }
      const snapshot: FuturesMarketSnapshot = {
        exchange: 'BYBIT',
        market: 'USDT LINEAR PERPETUALS',
        source: `${BYBIT_BASE_URL}/v5/market/instruments-info and /v5/market/tickers`,
        updatedAt: new Date(this.now()).toISOString(),
        symbols,
      };
      this.cached = { expiresAt: this.now() + CACHE_DURATION_MS, snapshot };
      return snapshot;
    } catch (error) {
      if (error instanceof BinanceMarketDataError) throw error;
      throw new BinanceMarketDataError('Bybit public futures market data is temporarily unavailable.');
    }
  }
}

export class PublicFuturesMarketsService implements FuturesMarketsProvider {
  constructor(
    private readonly primary: FuturesMarketsProvider = new BinanceFuturesMarketsService(),
    private readonly fallback: FuturesMarketsProvider = new BybitLinearFuturesMarketsService(),
  ) {}

  async list(): Promise<FuturesMarketSnapshot> {
    try {
      return await this.primary.list();
    } catch (primaryError) {
      try {
        return await this.fallback.list();
      } catch (fallbackError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : 'unknown provider error';
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'unknown provider error';
        throw new BinanceMarketDataError(
          `Public futures data is unavailable. Binance: ${primaryMessage} Bybit: ${fallbackMessage}`,
        );
      }
    }
  }
}
