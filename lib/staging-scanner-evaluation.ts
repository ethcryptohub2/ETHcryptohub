import { BinanceMarketScannerService, parseCandles, type MarketScannerCandidate } from '../smartexit/apps/api/src/services/market-scanner';
import type { FuturesMarketSnapshot } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { analyzeHighRiskScalpingSetup } from './high-risk-scalping';
import type { HighRiskScalpingSettings } from './high-risk-scalping-types';

export const scannerEvaluationBatchLimit = 3;
const origin = 'https://fapi.binance.com';
const intervalMs = 300_000;
const candleLimit = 400;
const bodyLimit = 1024 * 1024;

export class ScannerEvaluationFailure extends Error {
  constructor(public readonly code: string, public readonly providerStatus?: number) {
    super(code);
  }
}

async function marketJson(url: URL, request: typeof fetch, deadline: AbortSignal) {
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(3500)]);
  try {
    signal.throwIfAborted();
    const response = await request(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: { accept: 'application/json' },
    });
    const status = response.status;
    const weight = response.headers.get('x-mbx-used-weight-1m') ?? '';
    const reader = response.body?.getReader();
    try {
      if (status === 451) throw new ScannerEvaluationFailure('PROVIDER_REGION_RESTRICTION', status);
      if (status === 403) throw new ScannerEvaluationFailure('PROVIDER_DENIED', status);
      if (status === 418 || status === 429) throw new ScannerEvaluationFailure('PROVIDER_RATE_LIMIT', status);
      if (status !== 200) throw new ScannerEvaluationFailure('PROVIDER_HTTP_ERROR', status);
      if (!/^\d{1,6}$/.test(weight) || Number(weight) >= 300) {
        throw new ScannerEvaluationFailure('PROVIDER_WEIGHT_GUARD', status);
      }
      if (!reader) throw new ScannerEvaluationFailure('INVALID_PROVIDER_DATA', status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bodyLimit) throw new ScannerEvaluationFailure('INVALID_PROVIDER_DATA', status);
        chunks.push(value);
      }
      signal.throwIfAborted();
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new ScannerEvaluationFailure('INVALID_PROVIDER_DATA', status); }
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  } catch (error) {
    if (error instanceof ScannerEvaluationFailure) throw error;
    throw new ScannerEvaluationFailure(signal.aborted ? 'PROVIDER_TIMEOUT_OR_CANCELLED' : 'PROVIDER_NETWORK_ERROR');
  }
}

type EvaluationOptions = {
  symbols: readonly string[];
  minimumScore: number;
  highRisk: HighRiskScalpingSettings;
  signal: AbortSignal;
  request?: typeof fetch;
  now?: () => number;
  mode?: 'both' | 'high_risk';
  onStandardCandidates?: (candidates: MarketScannerCandidate[]) => void;
  beforeProviderRequest?: () => Promise<void>;
};

export async function evaluateStagingScanner(options: EvaluationOptions) {
  const { symbols, minimumScore, highRisk, signal, request = fetch, now = Date.now, mode = 'both' } = options;
  if (!symbols.length || symbols.length > scannerEvaluationBatchLimit ||
      new Set(symbols).size !== symbols.length || symbols.some(symbol => !/^[A-Z0-9]{1,20}USDT$/.test(symbol))) {
    throw new ScannerEvaluationFailure('INVALID_SYMBOL_BATCH');
  }
  if (!highRisk.enabled || !highRisk.enabledTimeframes.includes('5m')) {
    throw new ScannerEvaluationFailure('HIGH_RISK_5M_DISABLED');
  }
  const startedAt = new Date(now()).toISOString();
  async function readMarket(url: URL) {
    await options.beforeProviderRequest?.();
    return marketJson(url, request, signal);
  }
  const tickers = await readMarket(new URL('/fapi/v1/ticker/24hr', origin));
  if (!Array.isArray(tickers) || tickers.length > 5000) throw new ScannerEvaluationFailure('INVALID_PROVIDER_DATA');
  const receivedAt = now();
  const wanted = new Set([...symbols, 'BTCUSDT']);
  const quotes = new Map<string, { price: number; change: number; volume: number; count: number; observedAt: number }>();
  for (const row of tickers) {
    if (!row || !wanted.has(row.symbol)) continue;
    if (quotes.has(row.symbol)) throw new ScannerEvaluationFailure('INVALID_PROVIDER_DATA');
    const price = Number(row.lastPrice), change = Number(row.priceChangePercent), volume = Number(row.quoteVolume);
    if (![row.lastPrice, row.priceChangePercent, row.quoteVolume].every(value => typeof value === 'string' && value.trim() !== '') ||
      ![price, change, volume].every(Number.isFinite) || price <= 0 || volume < 0 ||
      !Number.isSafeInteger(row.count) || row.count < 0 ||
      !Number.isSafeInteger(row.closeTime) || row.closeTime > receivedAt || receivedAt - row.closeTime > 5000) {
      throw new ScannerEvaluationFailure('STALE_OR_INVALID_TICKER');
    }
    quotes.set(row.symbol, { price, change, volume, count: row.count, observedAt: row.closeTime });
  }
  if ([...wanted].some(symbol => !quotes.has(symbol))) throw new ScannerEvaluationFailure('MISSING_TICKER');
  const btcChange = quotes.get('BTCUSDT')!.change;
  const btcDirection = btcChange > 0.2 ? 'BULLISH' : btcChange < -0.2 ? 'BEARISH' : 'NEUTRAL';
  const rawCandles = new Map<string, unknown[]>();
  const validated = new Map<string, NonNullable<ReturnType<typeof parseCandles>>>();
  for (const symbol of symbols) {
    const url = new URL('/fapi/v1/klines', origin);
    url.search = new URLSearchParams({ symbol, interval: '5m', limit: String(candleLimit) }).toString();
    const data = await readMarket(url);
    const candles = parseCandles(data);
    if (!Array.isArray(data) || data.length > candleLimit || !candles ||
      !data.every((row, index) => Array.isArray(row) && row[0] === candles[index]?.openTime &&
        row[6] === candles[index]?.closeTime && [row[1], row[2], row[3], row[4], row[5]].every(value =>
          typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) &&
        Number(row[1]) >= candles[index]!.low && Number(row[1]) <= candles[index]!.high) ||
      !candles.every((candle, index) => Number.isSafeInteger(candle.openTime) && candle.openTime >= 0 &&
        candle.openTime % intervalMs === 0 && candle.closeTime === candle.openTime + intervalMs - 1 &&
        [candle.low, candle.high, candle.close, candle.volume].every(Number.isFinite) &&
        candle.low > 0 && candle.low <= candle.close && candle.close <= candle.high && candle.volume >= 0 &&
        (index === 0 || candle.openTime === candles[index - 1]!.openTime + intervalMs))) {
      throw new ScannerEvaluationFailure('INVALID_CANDLE_SERIES');
    }
    const observed = now();
    const closed = candles.filter(candle => candle.closeTime < observed);
    if (closed.length < 200 || closed.at(-1)?.closeTime !== Math.floor(observed / intervalMs) * intervalMs - 1 ||
        candles.length - closed.length > 1) throw new ScannerEvaluationFailure('STALE_OR_INSUFFICIENT_CANDLES');
    rawCandles.set(symbol, data.slice(0, closed.length));
    validated.set(symbol, closed);
  }
  const evaluatedAt = now();
  if (signal.aborted) throw new ScannerEvaluationFailure('PROVIDER_TIMEOUT_OR_CANCELLED');
  if ([...validated.values()].some(series => series.at(-1)?.closeTime !== Math.floor(evaluatedAt / intervalMs) * intervalMs - 1)) {
    throw new ScannerEvaluationFailure('CANDLE_INTERVAL_ROLLED_OVER');
  }
  if ([...quotes.values()].some(quote => evaluatedAt - quote.observedAt > 5000)) {
    throw new ScannerEvaluationFailure('STALE_OR_INVALID_TICKER');
  }
  const market: FuturesMarketSnapshot = {
    exchange: 'BINANCE', market: 'USDⓈ-M FUTURES', source: 'Binance unsigned public REST',
    updatedAt: new Date(Math.min(...[...quotes.values()].map(quote => quote.observedAt))).toISOString(),
    symbols: symbols.map(symbol => {
      const quote = quotes.get(symbol)!;
      return { symbol, baseAsset: symbol.slice(0, -4), quoteAsset: 'USDT', contractType: 'PERPETUAL',
        lastPrice: quote.price, priceChangePercent24h: quote.change, quoteVolume24h: quote.volume, tradeCount24h: quote.count };
    }),
  };
  const scanner = new BinanceMarketScannerService({ list: async () => market }, async input => {
    const url = new URL(String(input));
    return Response.json(rawCandles.get(url.searchParams.get('symbol') ?? '') ?? []);
  }, () => evaluatedAt);
  const standard = mode === 'both' ? await scanner.scan({
    quoteAsset: 'USDT', timeframe: '5m', symbols, minimumVolume: 10_000_000,
    limit: scannerEvaluationBatchLimit, atrPeriod: 10, multiplier: 3, maxAgeSeconds: 300, minimumScore,
  }) : null;
  if (standard) options.onStandardCandidates?.(standard.candidates);
  return {
    startedAt, evaluatedAt: new Date(evaluatedAt).toISOString(), quoteObservedAt: market.updatedAt,
    completed: symbols.length, total: symbols.length, timeframe: '5m' as const,
    rows: symbols.map(symbol => {
      const quote = quotes.get(symbol)!;
      const candles = validated.get(symbol)!;
      const candidate = standard?.candidates.find(item => item.symbol === symbol);
      const setup = quote.volume >= highRisk.minimumQuoteVolume
        ? analyzeHighRiskScalpingSetup({ symbol, timeframe: '5m', candles, price: quote.price, btcDirection, settings: highRisk, now: evaluatedAt })
        : null;
      return { symbol, candleCloseAt: new Date(candles.at(-1)!.closeTime).toISOString(),
        standard: standard && { status: candidate?.status === 'READY' && candidate.setup ? 'QUALIFIED' : 'WAIT',
          reason: candidate?.rationale ?? 'Standard evaluation returned no candidate', score: candidate?.score.value ?? null,
          setup: candidate?.status === 'READY' ? candidate.setup : null },
        highRisk: { status: setup ? 'QUALIFIED' : 'WAIT', score: setup?.score ?? null, setup,
          reason: setup ? 'High-Risk qualification passed' : quote.volume < highRisk.minimumQuoteVolume
            ? '24-hour quote volume is below the High-Risk minimum' : 'High-Risk breakout, trend, momentum, or score did not qualify' } };
    }),
  };
}
