import type {
  NormalizedCandle,
  NormalizedInstrument,
  ProviderTimeframe,
} from '../provider-types';

const COINAPI_BASE_URL = 'https://rest.coinapi.io/v1';
const BINANCEFTS_EXCHANGE_ID = 'BINANCEFTS';

export function toCoinApiPeriod(timeframe: ProviderTimeframe): string {
  switch (timeframe) {
    case '1m': return '1MIN';
    case '3m': return '3MIN';
    case '5m': return '5MIN';
    case '15m': return '15MIN';
    case '1h': return '1HRS';
    case '4h': return '4HRS';
  }
}

export function toCoinApiSymbolId(binanceSymbol: string): string {
  const upper = binanceSymbol.toUpperCase();
  if (!upper.endsWith('USDT') || upper.length < 5) {
    throw new Error(`Unsupported Binance USD-M symbol for CoinAPI mapping: ${binanceSymbol}`);
  }
  const base = upper.slice(0, -4);
  return `${BINANCEFTS_EXCHANGE_ID}_PERP_${base}_USDT`;
}

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

export async function discoverCoinApiInstruments(
  apiKey: string,
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedInstrument[]> {
  if (!apiKey) throw new Error('COINAPI_API_KEY is not configured.');
  const url = `${COINAPI_BASE_URL}/symbols?filter_exchange_id=${BINANCEFTS_EXCHANGE_ID}`;
  const response = await request(url, {
    headers: { 'X-CoinAPI-Key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const err = new Error(`CoinAPI symbols failed (${response.status}).`);
    (err as Error & { statusCode?: number }).statusCode = response.status;
    throw err;
  }
  const payload = (await response.json()) as Array<{
    symbol_id?: string;
    exchange_id?: string;
    symbol_type?: string;
    asset_id_base?: string;
    asset_id_quote?: string;
    future_is_inverse?: boolean;
  }>;
  if (!Array.isArray(payload)) throw new Error('CoinAPI returned invalid symbols payload.');

  return payload
    .filter(
      (s) =>
        s.exchange_id === BINANCEFTS_EXCHANGE_ID &&
        s.symbol_type === 'PERPETUAL' &&
        s.asset_id_quote === 'USDT' &&
        s.future_is_inverse !== true &&
        typeof s.asset_id_base === 'string' &&
        typeof s.symbol_id === 'string',
    )
    .map((s) => ({
      symbol: `${s.asset_id_base!.toUpperCase()}USDT`,
      baseAsset: s.asset_id_base!.toUpperCase(),
      quoteAsset: 'USDT' as const,
      contractType: 'PERPETUAL' as const,
      exchange: 'BINANCE' as const,
      status: 'TRADING',
      providerSymbol: s.symbol_id!,
    }));
}

export async function fetchCoinApiCandles(
  symbol: string,
  timeframe: ProviderTimeframe,
  apiKey: string,
  limit = 400,
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedCandle[]> {
  if (!apiKey) throw new Error('COINAPI_API_KEY is not configured.');
  const coinApiSymbol = toCoinApiSymbolId(symbol);
  const period = toCoinApiPeriod(timeframe);
  const url = new URL(`${COINAPI_BASE_URL}/ohlcv/${encodeURIComponent(coinApiSymbol)}/latest`);
  url.searchParams.set('period_id', period);
  url.searchParams.set('limit', String(Math.min(1000, Math.max(1, limit))));

  const response = await request(url, {
    headers: { 'X-CoinAPI-Key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const err = new Error(`CoinAPI OHLCV failed (${response.status}) for ${coinApiSymbol} ${period}.`);
    (err as Error & { statusCode?: number }).statusCode = response.status;
    throw err;
  }

  const payload = (await response.json()) as Array<{
    time_period_start?: string;
    time_period_end?: string;
    price_open?: number;
    price_high?: number;
    price_low?: number;
    price_close?: number;
    volume_traded?: number;
  }>;
  if (!Array.isArray(payload)) throw new Error(`CoinAPI returned invalid OHLCV for ${coinApiSymbol}.`);

  const now = Date.now();
  const intervalMs = timeframeMs(timeframe);
  const candles: NormalizedCandle[] = [];
  for (const bar of payload) {
    const openTime = Date.parse(bar.time_period_start ?? '');
    const endParsed = Date.parse(bar.time_period_end ?? '');
    const closeTime = Number.isFinite(endParsed) ? endParsed - 1 : openTime + intervalMs - 1;
    const open = Number(bar.price_open);
    const high = Number(bar.price_high);
    const low = Number(bar.price_low);
    const close = Number(bar.price_close);
    const volume = Number(bar.volume_traded);
    if (
      ![openTime, closeTime, open, high, low, close, volume].every(Number.isFinite) ||
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
      closeTime,
      isClosed: closeTime < now,
    });
  }

  return candles.sort((a, b) => a.openTime - b.openTime);
}
