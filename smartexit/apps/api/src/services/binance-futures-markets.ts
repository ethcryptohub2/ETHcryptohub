import { z } from 'zod';

const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const CACHE_DURATION_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

const exchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string().min(1),
      status: z.string(),
      contractType: z.string(),
      baseAsset: z.string().min(1),
      quoteAsset: z.string().min(1),
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

export interface FuturesMarketSnapshot {
  exchange: 'BINANCE';
  market: 'USDⓈ-M FUTURES';
  source: string;
  updatedAt: string;
  symbols: BinanceFuturesSymbol[];
}

export interface FuturesMarketsProvider {
  list(): Promise<FuturesMarketSnapshot>;
}

export class BinanceMarketDataError extends Error {
  constructor(message = 'Live Binance futures market data is temporarily unavailable.') {
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
      const options: RequestInit = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      const [exchangeResponse, tickerResponse] = await Promise.all([
        this.request(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`, options),
        this.request(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/24hr`, options),
      ]);

      if (!exchangeResponse.ok || !tickerResponse.ok) throw new BinanceMarketDataError();
      const [exchangeBody, tickerBody] = await Promise.all([exchangeResponse.json(), tickerResponse.json()]);
      const exchangeInfo = exchangeInfoSchema.safeParse(exchangeBody);
      const tickerData = tickerSchema.safeParse(tickerBody);
      if (!exchangeInfo.success || !tickerData.success) throw new BinanceMarketDataError();

      const tickers = new Map(tickerData.data.map((ticker) => [ticker.symbol, ticker]));
      const symbols = exchangeInfo.data.symbols
        .filter((contract) => contract.status === 'TRADING')
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

      if (symbols.length === 0) throw new BinanceMarketDataError();

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
      throw new BinanceMarketDataError();
    }
  }
}
