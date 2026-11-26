import { binanceRateLimiter, BinanceCooldownError, fetchBinanceRest } from '../../binance-rate-limit';
import type {
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedTicker,
  ProviderTimeframe,
} from '../provider-types';

const BASE_URL = 'https://fapi.binance.com';

function timeframeMs(tf: ProviderTimeframe): number {
  switch (tf) {
    case '1m': return 60_000;
    case '3m': return 3 * 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
  }
}

export async function discoverBinanceInstruments(
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedInstrument[]> {
  const response = await fetchBinanceRest(request, `${BASE_URL}/fapi/v1/exchangeInfo`, { weight: 1, timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`Binance exchangeInfo failed (${response.status}).`);
  const body = (await response.json()) as {
    symbols?: Array<{
      symbol?: string;
      status?: string;
      contractType?: string;
      baseAsset?: string;
      quoteAsset?: string;
    }>;
  };
  if (!Array.isArray(body.symbols)) throw new Error('Binance returned invalid exchangeInfo payload.');
  return body.symbols
    .filter(
      (s) =>
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT' &&
        typeof s.symbol === 'string' &&
        typeof s.baseAsset === 'string',
    )
    .map((s) => ({
      symbol: s.symbol!,
      baseAsset: s.baseAsset!,
      quoteAsset: 'USDT' as const,
      contractType: 'PERPETUAL' as const,
      exchange: 'BINANCE' as const,
      status: s.status ?? 'TRADING',
      providerSymbol: s.symbol!,
    }));
}

export async function fetchBinanceTickers(
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedTicker[]> {
  const now = Date.now();
  const response = await fetchBinanceRest(request, `${BASE_URL}/fapi/v1/ticker/24hr`, { weight: 40, timeoutMs: 10_000, now });
  if (!response.ok) throw new Error(`Binance ticker/24hr failed (${response.status}).`);
  const body = (await response.json()) as Array<{
    symbol?: string;
    lastPrice?: string;
    priceChangePercent?: string;
    quoteVolume?: string;
  }>;
  if (!Array.isArray(body)) throw new Error('Binance returned invalid ticker payload.');
  const tickers: NormalizedTicker[] = [];
  for (const row of body) {
    const price = Number(row.lastPrice);
    if (!row.symbol || !Number.isFinite(price) || price <= 0) continue;
    const pct = Number(row.priceChangePercent);
    const qVol = Number(row.quoteVolume);
    tickers.push({
      symbol: row.symbol,
      lastPrice: price,
      priceChangePercent24h: Number.isFinite(pct) ? pct : null,
      quoteVolume24h: Number.isFinite(qVol) ? qVol : null,
      timestamp: now,
      sourceProvider: 'binance',
    });
  }
  return tickers;
}

export async function fetchBinanceCandles(
  symbol: string,
  timeframe: ProviderTimeframe,
  limit = 400,
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedCandle[]> {
  const url = new URL(`${BASE_URL}/fapi/v1/klines`);
  url.searchParams.set('symbol', symbol.toUpperCase());
  url.searchParams.set('interval', timeframe);
  url.searchParams.set('limit', String(limit));
  const weight = limit <= 99 ? 1 : limit <= 499 ? 2 : 5;

  const response = await fetchBinanceRest(request, url, { weight, timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`Binance klines failed (${response.status}) for ${symbol} ${timeframe}.`);
  const body = (await response.json()) as unknown[];
  if (!Array.isArray(body)) throw new Error(`Binance returned invalid klines for ${symbol} ${timeframe}.`);

  const now = Date.now();
  const intervalMs = timeframeMs(timeframe);
  const candles: NormalizedCandle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const openTime = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    const closeTime = Number(row[6]);
    const quoteVolume = row.length >= 8 ? Number(row[7]) : undefined;
    if (
      ![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite) ||
      high < low ||
      close <= 0
    ) {
      continue;
    }
    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: quoteVolume !== undefined && Number.isFinite(quoteVolume) ? quoteVolume : undefined,
      closeTime: closeTime || openTime + intervalMs - 1,
      isClosed: closeTime < now,
    });
  }
  return candles.sort((a, b) => a.openTime - b.openTime);
}

export function getBinanceRateLimiterStatus() {
  return binanceRateLimiter.getStatus();
}

export { BinanceCooldownError };
