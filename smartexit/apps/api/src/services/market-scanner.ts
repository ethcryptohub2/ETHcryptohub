import { z } from 'zod';
import type { FuturesMarketsProvider } from './binance-futures-markets.js';

const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const CANDLE_CACHE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CANDLE_LIMIT = 240;
const MAX_CONCURRENT_CANDLE_REQUESTS = 5;
const TOP_MOVER_LIMIT = 5;
const EXCLUDED_BASE_ASSETS = new Set(['USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI']);
const LEVERAGED_SUFFIXES = ['UP', 'DOWN', 'BULL', 'BEAR', '2L', '2S', '3L', '3S'];

const candleRowSchema = z.array(z.union([z.string(), z.number()])).min(7);

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
  minimumVolume: number;
  limit: number;
  atrPeriod: number;
  multiplier: number;
  maxAgeSeconds: number;
  minimumScore: number;
}

export interface ScannerRiskContext {
  riskBudget: number;
  blockedReason: string | null;
}

export interface ScannerContribution {
  factor: string;
  weight: number;
  value: number;
  contribution: number;
}

export type MarketRank = 'TOP_VOLUME' | 'TOP_GAINER' | 'TOP_LOSER';

export interface MarketScannerCandidate {
  symbol: string;
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
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
    direction: 'BULLISH' | 'BEARISH' | 'MIXED' | 'UNAVAILABLE';
  };
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
    quantity: number;
    initialStop: number;
    trailingPercent: number;
    tp1: number;
    tp2: number;
    tp3: number;
    estimatedRisk: number;
    riskReward: [1, 2, 3];
  } | null;
  rationale: string;
  warnings: string[];
}

export interface MarketScannerResponse {
  exchange: 'BINANCE';
  market: 'USDⓈ-M FUTURES';
  source: string;
  updatedAt: string;
  timeframe: ScannerConfiguration['timeframe'];
  configuration: ScannerConfiguration;
  status: 'LIVE' | 'DEGRADED';
  candidates: MarketScannerCandidate[];
}

export interface MarketScannerProvider {
  scan(config: ScannerConfiguration, risk: ScannerRiskContext): Promise<MarketScannerResponse>;
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

function isEligibleBaseAsset(baseAsset: string): boolean {
  if (EXCLUDED_BASE_ASSETS.has(baseAsset)) return false;
  return !LEVERAGED_SUFFIXES.some((suffix) => baseAsset.endsWith(suffix));
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
    ema: { ema20: null, ema50: null, ema200: null, direction: 'UNAVAILABLE' },
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
  momentum: number,
  relativeVolume: number,
  structure: number | null,
): { value: number; coverage: number; contributions: ScannerContribution[] } {
  const factors = [
    { factor: 'Supertrend alignment', weight: 20, value: supertrend },
    { factor: 'EMA 20/50/200 alignment', weight: 30, value: ema },
    { factor: '24-hour momentum alignment', weight: 15, value: momentum },
    {
      factor: 'Relative volume',
      weight: 15,
      value: Math.min(100, Math.max(0, (relativeVolume / 1.5) * 100)),
    },
    ...(structure === null ? [] : [{ factor: 'Support/resistance room', weight: 20, value: structure }]),
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
  riskBudget: number,
): MarketScannerCandidate['setup'] {
  if (
    ![entryPrice, atr, riskBudget].every(Number.isFinite) ||
    entryPrice <= 0 ||
    atr <= 0 ||
    riskBudget <= 0
  ) {
    return null;
  }
  const stopDistance = atr * 1.5;
  const quantity = Number((riskBudget / stopDistance).toPrecision(8));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const initialStop = side === 'LONG' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const reward = stopDistance;
  const target = (multiple: number) =>
    side === 'LONG' ? entryPrice + reward * multiple : entryPrice - reward * multiple;
  if (initialStop <= 0 || target(3) <= 0) return null;
  return {
    entryPrice,
    quantity,
    initialStop,
    trailingPercent: Math.min(25, Math.max(0.1, (stopDistance / entryPrice) * 100)),
    tp1: target(1),
    tp2: target(2),
    tp3: target(3),
    estimatedRisk: Math.abs(entryPrice - initialStop) * quantity,
    riskReward: [1, 2, 3],
  };
}

export class BinanceMarketScannerService implements MarketScannerProvider {
  private readonly candleCache = new Map<string, { expiresAt: number; candles: MarketCandle[] }>();

  constructor(
    private readonly markets: FuturesMarketsProvider,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async scan(config: ScannerConfiguration, risk: ScannerRiskContext): Promise<MarketScannerResponse> {
    const snapshot = await this.markets.list();
    const eligibleMarkets = snapshot.symbols
      .filter(
        (market) =>
          market.quoteAsset === config.quoteAsset &&
          market.contractType === 'PERPETUAL' &&
          market.quoteVolume24h >= config.minimumVolume &&
          market.lastPrice !== null &&
          market.lastPrice > 0 &&
          isEligibleBaseAsset(market.baseAsset),
      )
      .sort(
        (left, right) =>
          right.quoteVolume24h - left.quoteVolume24h || left.symbol.localeCompare(right.symbol),
      );
    const rankedMarkets = new Map<
      string,
      { market: (typeof eligibleMarkets)[number]; ranks: Set<MarketRank> }
    >();
    const addRankedMarkets = (markets: (typeof eligibleMarkets)[number][], rank: MarketRank): void => {
      for (const market of markets) {
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
    const selectedMarkets = [...rankedMarkets.values()];
    const candidates: MarketScannerCandidate[] = [];
    for (let offset = 0; offset < selectedMarkets.length; offset += MAX_CONCURRENT_CANDLE_REQUESTS) {
      const batch = selectedMarkets.slice(offset, offset + MAX_CONCURRENT_CANDLE_REQUESTS);
      const results = await Promise.all(
        batch.map(async ({ market, ranks }) => {
          try {
            return await this.analyzeMarket(market, snapshot.updatedAt, config, risk, [...ranks]);
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
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      source: `${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines and /fapi/v1/ticker/24hr`,
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
  ): Promise<MarketCandle[]> {
    const key = `${symbol}:${timeframe}`;
    const cached = this.candleCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.candles;
    const url = new URL(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', timeframe);
    url.searchParams.set('limit', String(CANDLE_LIMIT));
    const response = await this.request(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Binance candle request failed (${response.status}).`);
    const candles = parseCandles(await response.json());
    if (!candles || candles.length === 0) throw new Error('Binance returned malformed candle data.');
    this.candleCache.set(key, { expiresAt: this.now() + CANDLE_CACHE_MS, candles });
    return candles;
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
    risk: ScannerRiskContext,
    marketRank: MarketRank[],
  ): Promise<MarketScannerCandidate> {
    const candles = await this.getCandles(market.symbol, config.timeframe);
    const now = this.now();
    const closedCandles = candles.filter((candle) => candle.closeTime < now);
    const indicator = calculateSupertrend(closedCandles, config.atrPeriod, config.multiplier);
    const lastCandle = closedCandles.at(-1);
    const ema20 = calculateEma(closedCandles, 20);
    const ema50 = calculateEma(closedCandles, 50);
    const ema200 = calculateEma(closedCandles, 200);
    if (!indicator || !lastCandle || ema20 === null || ema50 === null || ema200 === null) {
      const candidate = unavailableCandidate(market, config, marketRank);
      candidate.warnings = [
        'At least 200 completed candles are required to confirm EMA 20/50/200 and Supertrend.',
      ];
      return candidate;
    }
    const emaDirection =
      lastCandle.close > ema20 && ema20 > ema50 && ema50 > ema200
        ? 'BULLISH'
        : lastCandle.close < ema20 && ema20 < ema50 && ema50 < ema200
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
    const opposingLevel = isLong ? supportResistance.resistance : supportResistance.support;
    const structuralRoom =
      opposingLevel === null ? null : Math.abs(opposingLevel - market.lastPrice!) / (indicator.atr * 1.5);
    const structureValue =
      structuralRoom === null ? null : structuralRoom >= 2 ? 100 : structuralRoom >= 1.25 ? 50 : 0;
    const score = normalizedScore(
      trendAligned ? 100 : 0,
      emaDirection === 'MIXED' ? 0 : 100,
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
    } else if (emaDirection === 'MIXED') {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('EMA 20/50/200 are not in a confirmed directional stack.');
    } else if (!trendAligned) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift('Supertrend conflicts with the confirmed EMA 20/50/200 direction.');
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
    } else if (risk.blockedReason) {
      status = 'WAIT';
      finalSide = 'WAIT';
      warnings.unshift(risk.blockedReason);
    } else {
      setup = createSetup(side, market.lastPrice!, indicator.atr, risk.riskBudget);
      if (!setup) {
        status = 'WAIT';
        finalSide = 'WAIT';
        warnings.unshift('A valid risk-bounded setup could not be calculated.');
      }
    }

    if (opposingLevel === null) {
      warnings.push(
        'No confirmed opposing swing pivot was found; support/resistance score coverage is reduced.',
      );
    }
    const reasons = [
      `${emaDirection.toLowerCase()} EMA 20/50/200 stack`,
      `Supertrend ${trendAligned ? 'agrees' : 'conflicts'} on a completed ${config.timeframe} candle`,
      `relative volume ${relativeVolume.toFixed(2)}× its 20-candle baseline`,
      momentumAligned ? '24-hour momentum aligned' : '24-hour momentum conflicts',
      opposingLevel === null
        ? 'no opposing swing pivot identified'
        : `nearest opposing pivot ${structuralRoom!.toFixed(2)}R away`,
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
      ema: { ema20, ema50, ema200, direction: emaDirection },
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
