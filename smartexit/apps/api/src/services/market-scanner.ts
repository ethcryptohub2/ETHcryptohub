import { z } from 'zod';
import type { FuturesMarketSnapshot, FuturesMarketsProvider } from './binance-futures-markets.js';
import {
  type MarketResearchProvider,
  type MarketResearchSummary,
} from './market-research.js';

const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const BYBIT_BASE_URL = 'https://api.bybit.com';
const CANDLE_CACHE_MS = 15_000;
const CANDLE_LIMIT = 400;
const MAX_CONCURRENT_CANDLE_REQUESTS = 10;
const TOP_MOVER_LIMIT = 5;

const candleRowSchema = z.array(z.union([z.string(), z.number()])).min(7);

async function fetchCandleData(request: typeof fetch, url: URL): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(10_000) });
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
  throw lastError instanceof Error ? lastError : new Error('Public candle request failed.');
}

function intervalMilliseconds(timeframe: ScannerConfiguration['timeframe']): number {
  const minutes = timeframe === '5m' ? 5 : timeframe === '15m' ? 15 : timeframe === '1h' ? 60 : 240;
  return minutes * 60_000;
}

export function recommendedMaxAgeSeconds(timeframe: ScannerConfiguration['timeframe']): number {
  return Math.max(1800, intervalMilliseconds(timeframe) / 1000 + 60);
}

export interface MarketCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface ScannerConfiguration {
  quoteAsset: string;
  timeframe: '5m' | '15m' | '1h' | '4h';
  symbols?: readonly string[];
  minimumVolume: number;
  limit: number;
  atrPeriod: number;
  multiplier: number;
  maxAgeSeconds: number;
  minimumScore: number;
}

export interface ScannerContribution {
  factor: string;
  weight: number;
  value: number;
  contribution: number;
}

export interface TechnicalIndicators {
  rsi14: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  rollingVwap20: number | null;
  bollingerBands20: { lower: number; middle: number; upper: number } | null;
  adx14: number | null;
}

export type MarketRank = 'TOP_VOLUME' | 'TOP_GAINER' | 'TOP_LOSER';

export interface MarketScannerCandidate {
  symbol: string;
  scannedAt?: string;
  baseAsset: string;
  quoteAsset: string;
  marketRank: MarketRank[];
  price: number | null;
  priceChangePercent24h: number | null;
  quoteVolume24h: number;
  timeframe: ScannerConfiguration['timeframe'];
  lastCandleCloseAt: string | null;
  supertrend: {
    direction: 'BULLISH' | 'BEARISH' | 'UNAVAILABLE';
    atr: number | null;
    period: number;
    multiplier: number;
  };
  ema: {
    ema9: number | null;
    ema20: number | null;
    ema50: number | null;
    ema100: number | null;
    ema200: number | null;
    direction: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNAVAILABLE';
  };
  indicators: TechnicalIndicators;
  research: MarketResearchSummary;
  supportResistance: {
    support: number | null;
    resistance: number | null;
    source: 'COMPLETED_CANDLE_SWINGS';
  };
  relativeVolume: number | null;
  newsSentiment: { status: 'UNAVAILABLE'; source: null; updatedAt: null };
  socialSentiment: { status: 'UNAVAILABLE'; source: null; updatedAt: null };
  score: {
    value: number | null;
    coverage: number;
    contributions: ScannerContribution[];
  };
  side: 'LONG' | 'SHORT' | 'WAIT';
  status: 'READY' | 'WAIT' | 'STALE' | 'DATA_UNAVAILABLE';
  setup: {
    entryPrice: number;
    initialStop: number;
    tp1: number;
    tp2: number;
    tp3: number;
  } | null;
  rationale: string;
  warnings: string[];
}

export interface MarketScannerResponse {
  exchange: FuturesMarketSnapshot['exchange'];
  market: FuturesMarketSnapshot['market'];
  source: string;
  updatedAt: string;
  timeframe: ScannerConfiguration['timeframe'];
  configuration: ScannerConfiguration;
  status: 'LIVE' | 'DEGRADED';
  candidates: MarketScannerCandidate[];
}

export interface MarketScannerProvider {
  scan(config: ScannerConfiguration): Promise<MarketScannerResponse>;
}

function emptyResearch(): MarketResearchSummary {
  return {
    derivatives: {
      status: 'UNAVAILABLE',
      source: null,
      updatedAt: null,
      reason: 'Exchange metrics have not been loaded.',
      data: null,
    },
    liquidationHeatmap: {
      status: 'NOT_CONFIGURED',
      source: null,
      updatedAt: null,
      reason: 'CoinGlass API key is not configured.',
      data: null,
    },
    onChainFlow: {
      status: 'NOT_CONFIGURED',
      source: null,
      updatedAt: null,
      reason: 'Glassnode API key is not configured.',
      data: null,
    },
    news: {
      status: 'NOT_CONFIGURED',
      source: null,
      updatedAt: null,
      reason: 'CryptoPanic API key is not configured.',
      data: null,
    },
  };
}

export function calculateAtr(candles: MarketCandle[], period: number): number | null {
  if (!Number.isInteger(period) || period < 1 || candles.length < period + 1) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  if (trueRanges.length < period) return null;
  let atr = trueRanges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (const range of trueRanges.slice(period)) atr = (atr * (period - 1) + range) / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export function calculateEma(candles: MarketCandle[], period: number): number | null {
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return null;
  const closes = candles.map((candle) => candle.close);
  if (!closes.every((close) => Number.isFinite(close) && close > 0)) return null;
  let ema = closes.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
  const smoothing = 2 / (period + 1);
  for (const close of closes.slice(period)) ema = close * smoothing + ema * (1 - smoothing);
  return Number.isFinite(ema) && ema > 0 ? ema : null;
}

function calculateEmaSeries(values: number[], period: number): Array<number | null> {
  if (!Number.isInteger(period) || period < 1 || values.length < period) return [];
  if (!values.every((value) => Number.isFinite(value))) return [];
  const result: Array<number | null> = Array(values.length).fill(null);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const smoothing = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    ema = values[index]! * smoothing + ema * (1 - smoothing);
    result[index] = ema;
  }
  return result;
}

export function calculateRsi(candles: MarketCandle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 2 || candles.length <= period) return null;
  const changes = candles.slice(1).map((current, index) => current.close - candles[index]!.close);
  if (!changes.every(Number.isFinite)) return null;
  let averageGain = changes.slice(0, period).reduce((sum, change) => sum + Math.max(change, 0), 0) / period;
  let averageLoss = changes.slice(0, period).reduce((sum, change) => sum + Math.max(-change, 0), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rsi = 100 - 100 / (1 + averageGain / averageLoss);
  return Number.isFinite(rsi) ? rsi : null;
}

export function calculateMacd(
  candles: MarketCandle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { line: number; signal: number; histogram: number } | null {
  if (
    !Number.isInteger(fastPeriod) ||
    !Number.isInteger(slowPeriod) ||
    !Number.isInteger(signalPeriod) ||
    fastPeriod < 1 ||
    fastPeriod >= slowPeriod ||
    signalPeriod < 1
  ) {
    return null;
  }
  const closes = candles.map((candle) => candle.close);
  const fast = calculateEmaSeries(closes, fastPeriod);
  const slow = calculateEmaSeries(closes, slowPeriod);
  const macdValues: number[] = [];
  for (let index = 0; index < closes.length; index += 1) {
    if (fast[index] !== null && slow[index] !== null) macdValues.push(fast[index]! - slow[index]!);
  }
  const signalSeries = calculateEmaSeries(macdValues, signalPeriod);
  const line = macdValues.at(-1);
  const signal = signalSeries.at(-1);
  if (line === undefined || signal === undefined || signal === null) return null;
  const rawHistogram = line - signal;
  const precisionFloor = Number.EPSILON * Math.max(Math.abs(line), Math.abs(signal), 1) * 16;
  return {
    line,
    signal,
    histogram: Math.abs(rawHistogram) <= precisionFloor ? 0 : rawHistogram,
  };
}

export function calculateRollingVwap(candles: MarketCandle[], period = 20): number | null {
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return null;
  const recent = candles.slice(-period);
  const totalVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;
  const weightedPrice = recent.reduce(
    (sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume,
    0,
  );
  const vwap = weightedPrice / totalVolume;
  return Number.isFinite(vwap) && vwap > 0 ? vwap : null;
}

export function calculateBollingerBands(
  candles: MarketCandle[],
  period = 20,
  deviations = 2,
): { lower: number; middle: number; upper: number } | null {
  if (
    !Number.isInteger(period) ||
    period < 2 ||
    candles.length < period ||
    !Number.isFinite(deviations) ||
    deviations <= 0
  ) {
    return null;
  }
  const closes = candles.slice(-period).map((candle) => candle.close);
  const middle = closes.reduce((sum, close) => sum + close, 0) / period;
  const standardDeviation = Math.sqrt(
    closes.reduce((sum, close) => sum + (close - middle) ** 2, 0) / period,
  );
  const bands = {
    lower: middle - deviations * standardDeviation,
    middle,
    upper: middle + deviations * standardDeviation,
  };
  return Object.values(bands).every(Number.isFinite) ? bands : null;
}

export function calculateAdx(candles: MarketCandle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 2 || candles.length < period * 2 + 1) return null;
  const trueRanges: number[] = [];
  const positiveMoves: number[] = [];
  const negativeMoves: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    positiveMoves.push(upMove > downMove && upMove > 0 ? upMove : 0);
    negativeMoves.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothedTrueRange = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedPositive = positiveMoves.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedNegative = negativeMoves.slice(0, period).reduce((sum, value) => sum + value, 0);
  const directionalIndexes: number[] = [];
  for (let index = period - 1; index < trueRanges.length; index += 1) {
    if (index >= period) {
      smoothedTrueRange += trueRanges[index]! - smoothedTrueRange / period;
      smoothedPositive += positiveMoves[index]! - smoothedPositive / period;
      smoothedNegative += negativeMoves[index]! - smoothedNegative / period;
    }
    if (smoothedTrueRange <= 0) continue;
    const positiveDi = (100 * smoothedPositive) / smoothedTrueRange;
    const negativeDi = (100 * smoothedNegative) / smoothedTrueRange;
    const denominator = positiveDi + negativeDi;
    directionalIndexes.push(denominator === 0 ? 0 : (100 * Math.abs(positiveDi - negativeDi)) / denominator);
  }
  if (directionalIndexes.length < period) return null;
  let adx = directionalIndexes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of directionalIndexes.slice(period)) adx = (adx * (period - 1) + value) / period;
  return Number.isFinite(adx) ? adx : null;
}

export function calculateSupportResistance(
  candles: MarketCandle[],
  referencePrice: number,
  lookback = 60,
): { support: number | null; resistance: number | null } {
  if (
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0 ||
    !Number.isInteger(lookback) ||
    lookback < 3
  ) {
    return { support: null, resistance: null };
  }
  const start = Math.max(1, candles.length - lookback - 1);
  let support: number | null = null;
  let resistance: number | null = null;
  for (let index = start; index < candles.length - 1; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const next = candles[index + 1]!;
    if (current.low < previous.low && current.low <= next.low && current.low < referencePrice) {
      support = support === null ? current.low : Math.max(support, current.low);
    }
    if (current.high > previous.high && current.high >= next.high && current.high > referencePrice) {
      resistance = resistance === null ? current.high : Math.min(resistance, current.high);
    }
  }
  return { support, resistance };
}

export function calculateSupertrend(
  candles: MarketCandle[],
  period: number,
  multiplier: number,
): { direction: 'BULLISH' | 'BEARISH'; atr: number } | null {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isInteger(period) || period < 1) {
    return null;
  }
  if (candles.length < period + 2) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  if (ranges.length < period) return null;
  let atr = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  const firstAtrIndex = period;
  let previousUpper = (candles[firstAtrIndex]!.high + candles[firstAtrIndex]!.low) / 2 + multiplier * atr;
  let previousLower = (candles[firstAtrIndex]!.high + candles[firstAtrIndex]!.low) / 2 - multiplier * atr;
  let direction: 'BULLISH' | 'BEARISH' =
    candles[firstAtrIndex]!.close >= (candles[firstAtrIndex]!.high + candles[firstAtrIndex]!.low) / 2
      ? 'BULLISH'
      : 'BEARISH';

  for (let index = firstAtrIndex + 1; index < candles.length; index += 1) {
    atr = (atr * (period - 1) + ranges[index - 1]!) / period;
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const candle = candles[index]!;
    const midpoint = (candle.high + candle.low) / 2;
    const basicUpper = midpoint + multiplier * atr;
    const basicLower = midpoint - multiplier * atr;
    const finalUpper =
      basicUpper < previousUpper || candles[index - 1]!.close > previousUpper ? basicUpper : previousUpper;
    const finalLower =
      basicLower > previousLower || candles[index - 1]!.close < previousLower ? basicLower : previousLower;

    if (direction === 'BEARISH' && candle.close > previousUpper) direction = 'BULLISH';
    else if (direction === 'BULLISH' && candle.close < previousLower) direction = 'BEARISH';
    previousUpper = finalUpper;
    previousLower = finalLower;
  }
  return { direction, atr };
}

function parseCandles(body: unknown): MarketCandle[] | null {
  if (!Array.isArray(body)) return null;
  const candles: MarketCandle[] = [];
  for (const row of body) {
    const parsed = candleRowSchema.safeParse(row);
    if (!parsed.success) return null;
    const [openTime, , high, low, close, volume, closeTime] = parsed.data;
    const values = [openTime, high, low, close, volume, closeTime].map(Number);
    if (!values.every(Number.isFinite)) return null;
    const [parsedOpenTime, parsedHigh, parsedLow, parsedClose, parsedVolume, parsedCloseTime] = values;
    if (
      parsedOpenTime! < 0 ||
      parsedCloseTime! <= parsedOpenTime! ||
      parsedHigh! <= 0 ||
      parsedLow! <= 0 ||
      parsedClose! <= 0 ||
      parsedVolume! < 0 ||
      parsedHigh! < parsedLow!
    ) {
      return null;
    }
    candles.push({
      openTime: parsedOpenTime!,
      high: parsedHigh!,
      low: parsedLow!,
      close: parsedClose!,
      volume: parsedVolume!,
      closeTime: parsedCloseTime!,
    });
  }
  return candles.sort((left, right) => left.openTime - right.openTime);
}

function unavailableCandidate(
  market: {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    lastPrice: number | null;
    priceChangePercent24h: number | null;
    quoteVolume24h: number;
  },
  config: ScannerConfiguration,
  marketRank: MarketRank[],
  warning = 'Candle provider failed or returned malformed data.',
): MarketScannerCandidate {
  return {
    symbol: market.symbol,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    marketRank,
    price: market.lastPrice,
    priceChangePercent24h: market.priceChangePercent24h,
    quoteVolume24h: market.quoteVolume24h,
    timeframe: config.timeframe,
    lastCandleCloseAt: null,
    supertrend: {
      direction: 'UNAVAILABLE',
      atr: null,
      period: config.atrPeriod,
      multiplier: config.multiplier,
    },
    ema: { ema9: null, ema20: null, ema50: null, ema100: null, ema200: null, direction: 'UNAVAILABLE' },
    indicators: {
      rsi14: null,
      macdLine: null,
      macdSignal: null,
      macdHistogram: null,
      rollingVwap20: null,
      bollingerBands20: null,
      adx14: null,
    },
    research: emptyResearch(),
    supportResistance: { support: null, resistance: null, source: 'COMPLETED_CANDLE_SWINGS' },
    relativeVolume: null,
    newsSentiment: { status: 'UNAVAILABLE', source: null, updatedAt: null },
    socialSentiment: { status: 'UNAVAILABLE', source: null, updatedAt: null },
    score: { value: null, coverage: 0, contributions: [] },
    side: 'WAIT',
    status: 'DATA_UNAVAILABLE',
    setup: null,
    rationale: 'WAIT: confirmed candle data is unavailable; no trade setup is proposed.',
    warnings: [warning],
  };
}

function normalizedScore(
  supertrend: number,
  ema: number,
  rsi: number,
  macd: number,
  vwap: number,
  adx: number,
  momentum: number,
  relativeVolume: number,
  structure: number | null,
): { value: number; coverage: number; contributions: ScannerContribution[] } {
  const factors = [
    { factor: 'Supertrend alignment', weight: 15, value: supertrend },
    { factor: 'EMA 9/20/50/100/200 alignment', weight: 20, value: ema },
    { factor: 'RSI 14 direction', weight: 10, value: rsi },
    { factor: 'MACD 12/26/9 direction', weight: 15, value: macd },
    { factor: 'Rolling VWAP alignment', weight: 10, value: vwap },
    { factor: 'ADX 14 trend strength', weight: 10, value: adx },
    { factor: '24-hour momentum alignment', weight: 10, value: momentum },
    {
      factor: 'Relative volume',
      weight: 5,
      value: Math.min(100, Math.max(0, (relativeVolume / 1.5) * 100)),
    },
    ...(structure === null ? [] : [{ factor: 'Support/resistance room', weight: 5, value: structure }]),
  ];
  const availableWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const raw = factors.reduce((sum, factor) => sum + (factor.value * factor.weight) / 100, 0);
  return {
    value: Math.round((raw / availableWeight) * 100),
    coverage: availableWeight,
    contributions: factors.map((factor) => ({
      ...factor,
      contribution: Math.round((factor.value * factor.weight) / availableWeight),
    })),
  };
}

function createSetup(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  atr: number,
): MarketScannerCandidate['setup'] {
  if (![entryPrice, atr].every(Number.isFinite) || entryPrice <= 0 || atr <= 0) return null;
  const stopDistance = atr * 1.5;
  const initialStop = side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const reward = stopDistance;
  const target = (multiple: number) =>
    side === 'LONG' ? entryPrice + reward * multiple : entryPrice - reward * multiple;
  if (initialStop <= 0 || target(3) <= 0) return null;
  return {
    entryPrice,
    initialStop,
    tp1: target(1),
    tp2: target(2),
    tp3: target(3),
  };
}

function researchRationale(research: MarketResearchSummary): string[] {
  const reasons: string[] = [];
  const derivatives = research.derivatives;
  if (derivatives.status === 'LIVE' && derivatives.data) {
    reasons.push(
      `funding ${derivatives.data.fundingRatePercent.toFixed(4)}%` +
      (derivatives.data.openInterestChangePercent === null
        ? ', open-interest change unavailable'
        : `, open interest ${derivatives.data.openInterestChangePercent >= 0 ? '+' : ''}${derivatives.data.openInterestChangePercent.toFixed(2)}%`),
    );
  } else {
    reasons.push(`funding/open-interest context ${derivatives.reason ?? derivatives.status.toLowerCase()}`);
  }
  const heatmap = research.liquidationHeatmap;
  if (heatmap.status === 'LIVE' && heatmap.data) {
    const above = heatmap.data.nearestAbove;
    const below = heatmap.data.nearestBelow;
    reasons.push(
      `nearest liquidation heatmap level above ${above ? above.price.toPrecision(6) : 'not found'}, below ${below ? below.price.toPrecision(6) : 'not found'}`,
    );
  } else {
    reasons.push(`liquidation heatmap ${heatmap.reason ?? heatmap.status.toLowerCase()}`);
  }
  const flow = research.onChainFlow;
  if (flow.status === 'LIVE' && flow.data) {
    reasons.push(
      `Glassnode ${flow.data.asset} exchange netflow ${flow.data.exchangeNetflow >= 0 ? '+' : ''}${flow.data.exchangeNetflow.toPrecision(5)} ${flow.data.asset}; exchange flow is not verified smart-wallet attribution`,
    );
  } else {
    reasons.push(`on-chain exchange-flow context ${flow.reason ?? flow.status.toLowerCase()}`);
  }
  const news = research.news;
  if (news.status === 'LIVE' && news.data) {
    reasons.push(
      `CryptoPanic ${news.data.itemCount} news items with ${news.data.positiveVotes} positive and ${news.data.negativeVotes} negative community votes; votes are not independently verified sentiment`,
    );
  } else {
    reasons.push(`news context ${news.reason ?? news.status.toLowerCase()}`);
  }
  return reasons;
}

export class BinanceMarketScannerService implements MarketScannerProvider {
  private readonly candleCache = new Map<string, { expiresAt: number; candles: MarketCandle[] }>();

  constructor(
    private readonly markets: FuturesMarketsProvider,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly research: MarketResearchProvider | null = null,
  ) {}

  async scan(config: ScannerConfiguration): Promise<MarketScannerResponse> {
    const snapshot = await this.markets.list();
    const eligibleMarkets = snapshot.symbols
      .filter(
        (market) =>
          market.quoteAsset === config.quoteAsset &&
          market.contractType === 'PERPETUAL' &&
          /^[\p{L}\p{N}]{2,30}$/u.test(market.symbol) &&
          /^[\p{L}\p{N}]{1,20}$/u.test(market.baseAsset) &&
          market.symbol === `${market.baseAsset}${market.quoteAsset}` &&
          market.lastPrice !== null &&
          market.lastPrice > 0,
      )
      .sort(
        (left, right) =>
          right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol),
      );
    const rankedMarkets = new Map<
      string,
      { market: (typeof eligibleMarkets)[number]; ranks: Set<MarketRank> }
    >();
    const targetSymbols = config.symbols ? new Set(config.symbols) : null;
    const addRankedMarkets = (markets: (typeof eligibleMarkets)[number][], rank: MarketRank): void => {
      for (const market of markets) {
        if (targetSymbols && !targetSymbols.has(market.symbol)) continue;
        const existing = rankedMarkets.get(market.symbol);
        if (existing) existing.ranks.add(rank);
        else rankedMarkets.set(market.symbol, { market, ranks: new Set([rank]) });
      }
    };
    addRankedMarkets(eligibleMarkets.slice(0, config.limit), 'TOP_VOLUME');
    const gainers = eligibleMarkets.filter(
      (market) => market.priceChangePercent24h !== null && market.priceChangePercent24h > 0,
    );
    const losers = eligibleMarkets.filter(
      (market) => market.priceChangePercent24h !== null && market.priceChangePercent24h < 0,
    );
    addRankedMarkets(
      [...gainers]
        .sort(
          (left, right) =>
            right.priceChangePercent24h! - left.priceChangePercent24h! ||
            left.symbol.localeCompare(right.symbol),
        )
        .slice(0, TOP_MOVER_LIMIT),
      'TOP_GAINER',
    );
    addRankedMarkets(
      [...losers]
        .sort(
          (left, right) =>
            left.priceChangePercent24h! - right.priceChangePercent24h! ||
            left.symbol.localeCompare(right.symbol),
        )
        .slice(0, TOP_MOVER_LIMIT),
      'TOP_LOSER',
    );
    if (targetSymbols) {
      for (const market of eligibleMarkets) {
        if (targetSymbols.has(market.symbol) && !rankedMarkets.has(market.symbol)) {
          rankedMarkets.set(market.symbol, { market, ranks: new Set() });
        }
      }
    }
    const selectedMarkets = [...rankedMarkets.values()];
    const candidates: MarketScannerCandidate[] = [];
    for (let offset = 0; offset < selectedMarkets.length; offset += MAX_CONCURRENT_CANDLE_REQUESTS) {
      const batch = selectedMarkets.slice(offset, offset + MAX_CONCURRENT_CANDLE_REQUESTS);
      const results = await Promise.all(
        batch.map(async ({ market, ranks }) => {
          try {
            return await this.analyzeMarket(market, snapshot.updatedAt, config, [...ranks], snapshot.exchange);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown candle provider error.';
            return unavailableCandidate(market, config, [...ranks], `Candle data unavailable: ${message}`);
          }
        }),
      );
      candidates.push(...results);
    }
    candidates.sort((left, right) => {
      if (left.status === 'READY' && right.status !== 'READY') return -1;
      if (right.status === 'READY' && left.status !== 'READY') return 1;
      return (right.score.value ?? -1) - (left.score.value ?? -1);
    });
    const hasDataErrors = candidates.some(
      (candidate) => candidate.status === 'DATA_UNAVAILABLE' || candidate.status === 'STALE',
    );
    return {
      exchange: snapshot.exchange,
      market: snapshot.market,
      source: snapshot.source,
      updatedAt: new Date(this.now()).toISOString(),
      timeframe: config.timeframe,
      configuration: config,
      status: hasDataErrors ? 'DEGRADED' : 'LIVE',
      candidates,
    };
  }

  private async getCandles(
    symbol: string,
    timeframe: ScannerConfiguration['timeframe'],
    preferredExchange: FuturesMarketSnapshot['exchange'],
  ): Promise<MarketCandle[]> {
    const key = `${preferredExchange}:${symbol}:${timeframe}`;
    const cached = this.candleCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.candles;
    const providers = [preferredExchange] as const;
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        const url = new URL(provider === 'BYBIT'
          ? `${BYBIT_BASE_URL}/v5/market/kline`
          : `${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines`);
        if (provider === 'BYBIT') {
          url.searchParams.set('category', 'linear');
          url.searchParams.set('interval', timeframe === '1h' ? '60' : timeframe === '4h' ? '240' : timeframe.slice(0, -1));
        } else {
          url.searchParams.set('interval', timeframe);
        }
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('limit', String(CANDLE_LIMIT));
        const response = await fetchCandleData(this.request, url);
        const body = await response.json();
        let candles: MarketCandle[] | null;
        if (provider === 'BYBIT') {
          const parsed = z.object({
            retCode: z.literal(0),
            result: z.object({ list: z.array(candleRowSchema) }),
          }).safeParse(body);
          candles = parsed.success
            ? parsed.data.result.list.map((row) => ({
                openTime: Number(row[0]),
                high: Number(row[2]),
                low: Number(row[3]),
                close: Number(row[4]),
                volume: Number(row[5]),
                closeTime: Number(row[0]) + intervalMilliseconds(timeframe) - 1,
              })).sort((left, right) => left.openTime - right.openTime)
            : null;
        } else {
          candles = parseCandles(body);
        }
        if (!candles?.length || candles.some((candle) =>
          ![candle.openTime, candle.high, candle.low, candle.closeTime].every(Number.isFinite) ||
          ![candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
        )) throw new Error('invalid candle response');
        this.candleCache.set(key, { expiresAt: this.now() + CANDLE_CACHE_MS, candles });
        return candles;
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    throw new Error(`Candle data is unavailable from public futures providers (${failures.join('; ')}).`);
  }

  private async analyzeMarket(
    market: {
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      lastPrice: number | null;
      priceChangePercent24h: number | null;
      quoteVolume24h: number;
    },
    marketUpdatedAt: string,
    config: ScannerConfiguration,
    marketRank: MarketRank[],
    exchange: FuturesMarketSnapshot['exchange'],
  ): Promise<MarketScannerCandidate> {
    const candles = await this.getCandles(market.symbol, config.timeframe, exchange);
    const now = this.now();
    const closedCandles = candles.filter((candle) => candle.closeTime < now);
    const indicator = calculateSupertrend(closedCandles, config.atrPeriod, config.multiplier);
    const lastCandle = closedCandles.at(-1);
    const ema9 = calculateEma(closedCandles, 9);
    const ema20 = calculateEma(closedCandles, 20);
    const ema50 = calculateEma(closedCandles, 50);
    const ema100 = calculateEma(closedCandles, 100);
    const ema200 = calculateEma(closedCandles, 200);
    const rsi14 = calculateRsi(closedCandles);
    const macd = calculateMacd(closedCandles);
    const rollingVwap20 = calculateRollingVwap(closedCandles);
    const bollingerBands20 = calculateBollingerBands(closedCandles);
    const adx14 = calculateAdx(closedCandles);
    if (
      !indicator ||
      !lastCandle ||
      ema9 === null ||
      ema20 === null ||
      ema50 === null ||
      ema100 === null ||
      ema200 === null ||
      rsi14 === null ||
      macd === null ||
      rollingVwap20 === null ||
      bollingerBands20 === null ||
      adx14 === null
    ) {
      const candidate = unavailableCandidate(market, config, marketRank);
      candidate.warnings = [
        'Completed candle history or volume is insufficient to calculate every required technical indicator.',
      ];
      return candidate;
    }
    const research = this.research
      ? await this.research.getResearch({
          symbol: market.symbol,
          baseAsset: market.baseAsset,
          exchange,
          timeframe: config.timeframe,
          price: market.lastPrice!,
        })
      : emptyResearch();
    const emaDirection =
      lastCandle.close > ema9 && ema9 > ema20 && ema20 > ema50 && ema50 > ema100 && ema100 > ema200
        ? 'BULLISH'
        : lastCandle.close < ema9 && ema9 < ema20 && ema20 < ema50 && ema50 < ema100 && ema100 < ema200
          ? 'BEARISH'
          : 'MIXED';
    const supportResistance = calculateSupportResistance(closedCandles, market.lastPrice!);
    const candleAge = now - lastCandle.closeTime;
    const tickerAge = now - Date.parse(marketUpdatedAt);
    const stale =
      !Number.isFinite(tickerAge) ||
      tickerAge > config.maxAgeSeconds * 1000 ||
      candleAge > config.maxAgeSeconds * 1000;
    const priorVolumes = closedCandles.slice(-21, -1).map((candle) => candle.volume);
    const averagePriorVolume = priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length;
    const relativeVolume = averagePriorVolume > 0 ? lastCandle.volume / averagePriorVolume : null;
    if (relativeVolume === null || !Number.isFinite(relativeVolume)) {
      const candidate = unavailableCandidate(market, config, marketRank);
      candidate.warnings = ['Relative volume could not be calculated from valid completed candles.'];
      return candidate;
    }
    const direction = indicator.direction;
    const trendAligned = emaDirection === direction;
    const momentumAligned =
      market.priceChangePercent24h !== null &&
      (emaDirection === 'BULLISH'
        ? market.priceChangePercent24h >= 0
        : emaDirection === 'BEARISH' && market.priceChangePercent24h <= 0);
    const isLong = emaDirection === 'BULLISH';
    const side = isLong ? 'LONG' : 'SHORT';
    const rsiAligned = isLong ? rsi14 > 50 : rsi14 < 50;
    const macdAligned = isLong ? macd.histogram > 0 : macd.histogram < 0;
    const vwapAligned = isLong ? market.lastPrice! > rollingVwap20 : market.lastPrice! < rollingVwap20;
    const adxStrong = adx14 >= 20;
    const opposingLevel = isLong ? supportResistance.resistance : supportResistance.support;
    const structuralRoom =
      opposingLevel === null ? null : Math.abs(opposingLevel - market.lastPrice!) / (indicator.atr * 1.5);
    const structureValue =
      structuralRoom === null ? null : structuralRoom >= 2 ? 100 : structuralRoom >= 1.25 ? 50 : 0;
    const score = normalizedScore(
      trendAligned ? 100 : 0,
      emaDirection === 'MIXED' ? 0 : 100,
      rsiAligned ? 100 : 0,
      macdAligned ? 100 : 0,
      vwapAligned ? 100 : 0,
      adxStrong ? Math.min(100, (adx14 / 30) * 100) : 0,
      momentumAligned ? 100 : 0,
      relativeVolume,
      structureValue,
    );
    const warnings: string[] = [
      'EMA trend is based on candle closes; this scanner does not include verified news/social sentiment.',
    ];
    let status: MarketScannerCandidate['status'] = 'READY';
    let finalSide: MarketScannerCandidate['side'] = side;
    let setup: MarketScannerCandidate['setup'] = null;
    if (stale) {
      status = 'STALE';
      finalSide = 'WAIT';
      warnings.unshift('Market ticker or last completed candle exceeds the configured freshness limit.');
    } else if (market.quoteVolume24h < config.minimumVolume) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(`24-hour quote volume is below the configured ${config.minimumVolume.toLocaleString()} minimum.`);
    } else if (emaDirection === 'MIXED') {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('EMA 9/20/50/100/200 are not in a confirmed directional stack.');
    } else if (!trendAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('Supertrend conflicts with the confirmed EMA 9/20/50/100/200 direction.');
    } else if (!rsiAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(`RSI 14 (${rsi14.toFixed(1)}) does not confirm the proposed ${side} direction.`);
    } else if (!macdAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('MACD histogram does not confirm the proposed direction.');
    } else if (!vwapAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('Price is on the wrong side of the rolling 20-candle VWAP.');
    } else if (!adxStrong) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(`ADX 14 (${adx14.toFixed(1)}) is below the minimum trend-strength threshold of 20.`);
    } else if (!momentumAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('24-hour momentum conflicts with the confirmed EMA direction.');
    } else if (relativeVolume < 1) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('The last completed candle volume is below its 20-candle baseline.');
    } else if (score.value < config.minimumScore) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(`Setup score is below the configured minimum of ${config.minimumScore}.`);
    } else if (structureValue === 0) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(
        'The nearest opposing support/resistance pivot is too close to the proposed first target.',
      );
    } else {
      setup = createSetup(side, market.lastPrice!, indicator.atr);
      if (!setup) {
        status = 'WAIT';
        finalSide = 'WAIT';
        warnings.unshift('Technical reference levels could not be calculated.');
      }
    }

    if (opposingLevel === null) {
      warnings.push(
        'No confirmed opposing swing pivot was found; support/resistance score coverage is reduced.',
      );
    }
    const reasons = [
      `${emaDirection.toLowerCase()} EMA 9/20/50/100/200 stack`,
      `RSI 14 ${rsi14.toFixed(1)}`,
      `MACD histogram ${macd.histogram.toPrecision(5)}`,
      `price ${vwapAligned ? 'above' : 'below'} rolling VWAP`,
      `ADX 14 ${adx14.toFixed(1)}`,
      `Supertrend ${trendAligned ? 'agrees' : 'conflicts'} on a completed ${config.timeframe} candle`,
      `relative volume ${relativeVolume.toFixed(2)}× its 20-candle baseline`,
      momentumAligned ? '24-hour momentum aligned' : '24-hour momentum conflicts',
      opposingLevel === null
        ? 'no opposing swing pivot identified'
        : `nearest opposing pivot ${structuralRoom!.toFixed(2)}R away`,
      ...researchRationale(research),
    ];
    return {
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      marketRank,
      price: market.lastPrice,
      priceChangePercent24h: market.priceChangePercent24h,
      quoteVolume24h: market.quoteVolume24h,
      timeframe: config.timeframe,
      lastCandleCloseAt: new Date(lastCandle.closeTime).toISOString(),
      supertrend: {
        direction,
        atr: indicator.atr,
        period: config.atrPeriod,
        multiplier: config.multiplier,
      },
      ema: { ema9, ema20, ema50, ema100, ema200, direction: emaDirection },
      indicators: {
        rsi14,
        macdLine: macd.line,
        macdSignal: macd.signal,
        macdHistogram: macd.histogram,
        rollingVwap20,
        bollingerBands20,
        adx14,
      },
      research,
      supportResistance: { ...supportResistance, source: 'COMPLETED_CANDLE_SWINGS' },
      relativeVolume,
      newsSentiment: { status: 'UNAVAILABLE', source: null, updatedAt: null },
      socialSentiment: { status: 'UNAVAILABLE', source: null, updatedAt: null },
      score,
      side: finalSide,
      status,
      setup,
      rationale:
        finalSide === 'WAIT'
          ? `WAIT: ${reasons.join('; ')}. Review the warnings before considering a paper setup.`
          : `${finalSide} candidate: ${reasons.join('; ')}. Score is a rule-based ranking, not a probability of profit.`,
      warnings,
    };
  }
}
