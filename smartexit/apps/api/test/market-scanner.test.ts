import { describe, expect, it } from 'vitest';
import type { FuturesMarketSnapshot } from '../src/services/binance-futures-markets.js';
import {
  BinanceMarketScannerService,
  calculateAtr,
  calculateAdx,
  calculateBollingerBands,
  calculateEma,
  calculateMacd,
  calculateRsi,
  calculateRollingVwap,
  calculateSupportResistance,
  calculateSupertrend,
  type MarketCandle,
  type ScannerConfiguration,
} from '../src/services/market-scanner.js';

const config: ScannerConfiguration = {
  quoteAsset: 'USDT',
  timeframe: '15m',
  minimumVolume: 10_000_000,
  limit: 1,
  atrPeriod: 10,
  multiplier: 3,
  maxAgeSeconds: 180,
  minimumScore: 60,
};

function candle(close: number, index: number): MarketCandle {
  return {
    openTime: index * 60_000,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100,
    closeTime: (index + 1) * 60_000 - 1,
  };
}

function snapshot(now: number, market: { price?: number; change?: number } = {}): FuturesMarketSnapshot {
  return {
    exchange: 'BINANCE',
    market: 'USDⓈ-M FUTURES',
    source: 'test fixture',
    updatedAt: new Date(now - 1000).toISOString(),
    symbols: [
      {
        symbol: 'BTCUSDT',
        contractType: 'PERPETUAL',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        lastPrice: market.price ?? 147.8,
        priceChangePercent24h: market.change ?? 2,
        quoteVolume24h: 20_000_000,
        tradeCount24h: 1,
      },
    ],
  };
}

function binanceRow(item: MarketCandle): string[] {
  return [
    String(item.openTime),
    String(item.close),
    String(item.high),
    String(item.low),
    String(item.close),
    String(item.volume),
    String(item.closeTime),
  ];
}

describe('market scanner indicators', () => {
  it('calculates ATR from true ranges and smooths subsequent candles', () => {
    const candles = [
      { ...candle(10, 0), high: 12, low: 8 },
      { ...candle(12, 1), high: 14, low: 10 },
      { ...candle(14, 2), high: 15, low: 11 },
    ];
    expect(calculateAtr(candles, 2)).toBe(4);
    expect(calculateAtr(candles.slice(0, 2), 2)).toBeNull();
  });

  it('confirms Supertrend direction from a sufficient rising or falling candle history', () => {
    const rising = Array.from({ length: 40 }, (_, index) => candle(100 + index * 2, index));
    const falling = Array.from({ length: 40 }, (_, index) => candle(200 - index * 2, index));
    expect(calculateSupertrend(rising, 10, 3)?.direction).toBe('BULLISH');
    expect(calculateSupertrend(falling, 10, 3)?.direction).toBe('BEARISH');
    expect(calculateSupertrend(rising.slice(0, 10), 10, 3)).toBeNull();
  });

  it('calculates EMA and nearest confirmed candle-swing support and resistance', () => {
    expect(calculateEma([candle(1, 0), candle(2, 1), candle(3, 2)], 2)).toBe(2.5);
    expect(calculateEma([candle(1, 0)], 2)).toBeNull();

    const swings = [15, 14, 16, 20, 16, 17, 18].map((high, index) => ({
      ...candle(12 + index, index),
      high,
      low: [10, 8, 11, 12, 9, 13, 14][index]!,
    }));
    expect(calculateSupportResistance(swings, 15)).toEqual({ support: 9, resistance: 20 });
  });

  it('calculates RSI, MACD, rolling VWAP, Bollinger Bands, and ADX from candles', () => {
    const rising = Array.from({ length: 60 }, (_, index) => candle(100 + index + index ** 2 * 0.1, index));
    const falling = Array.from({ length: 60 }, (_, index) => candle(220 - index - index ** 2 * 0.1, index));

    expect(calculateRsi(rising)).toBe(100);
    expect(calculateRsi(falling)).toBe(0);
    expect(calculateRsi([candle(1, 0)], 14)).toBeNull();
    expect(calculateMacd(rising)?.histogram).toBeGreaterThan(0);
    expect(calculateMacd(falling)?.histogram).toBeLessThan(0);
    expect(calculateMacd(rising.slice(0, 34))).not.toBeNull();
    expect(calculateMacd(rising.slice(0, 33))).toBeNull();
    expect(calculateRollingVwap(rising)).toBeGreaterThan(rising[39]!.close);
    expect(calculateRollingVwap(rising.slice(0, 19))).toBeNull();
    expect(calculateBollingerBands(rising)?.lower).toBeLessThan(
      calculateBollingerBands(rising)!.middle,
    );
    expect(calculateBollingerBands(rising)!.middle).toBeLessThan(
      calculateBollingerBands(rising)!.upper,
    );
    expect(calculateAdx(rising)).toBeGreaterThan(20);
    expect(calculateAdx(rising.slice(0, 28))).toBeNull();
  });
});

describe('Binance market scanner service', () => {
  it('scans every eligible USDT perpetual even when the legacy limit is lower', async () => {
    const now = 241 * 60_000;
    const closedCandles = Array.from({ length: 240 }, (_, index) => candle(100 + index * 0.2, index));
    const markets = snapshot(now);
    const btc = markets.symbols[0]!;
    const service = new BinanceMarketScannerService(
      {
        list: async () => ({
          ...markets,
          symbols: [
            btc,
            {
              ...btc,
              symbol: 'ETHUSDT',
              baseAsset: 'ETH',
              lastPrice: 147.8,
              priceChangePercent24h: -1,
            },
          ],
        }),
      },
      async () => new Response(JSON.stringify(closedCandles.map(binanceRow))),
      () => now,
    );

    const result = await service.scan({ ...config, limit: 1 });

    expect(result.candidates.map((candidate) => candidate.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('uses completed candles only and creates directionally valid informational levels', async () => {
    const now = 241 * 60_000;
    const closedCandles = Array.from({ length: 240 }, (_, index) => candle(100 + index * 0.2, index));
    const unfinishedCandle: MarketCandle = {
      openTime: now,
      high: 300,
      low: 1,
      close: 1,
      volume: 1000,
      closeTime: now + 60_000,
    };
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify([...closedCandles.map(binanceRow), binanceRow(unfinishedCandle)]));
    const service = new BinanceMarketScannerService({ list: async () => snapshot(now) }, fetcher, () => now);
    const result = await service.scan(config);
    const candidate = result.candidates[0]!;

    expect(result.status).toBe('LIVE');
    expect(candidate.status).toBe('READY');
    expect(candidate.side).toBe('LONG');
    expect(candidate.ema.direction).toBe('BULLISH');
    expect(candidate.ema.ema9).not.toBeNull();
    expect(candidate.supertrend.direction).toBe('BULLISH');
    expect(candidate.indicators.rsi14).toBeGreaterThan(50);
    expect(candidate.indicators.macdHistogram).toBeGreaterThan(0);
    expect(candidate.indicators.adx14).toBeGreaterThan(20);
    expect(candidate.lastCandleCloseAt).toBe(new Date(closedCandles.at(-1)!.closeTime).toISOString());
    expect(candidate.newsSentiment.status).toBe('UNAVAILABLE');
    expect(candidate.socialSentiment.status).toBe('UNAVAILABLE');
    expect(candidate.score.coverage).toBe(95);
    expect(candidate.marketRank).toContain('TOP_GAINER');
    expect(candidate.ema.ema200).not.toBeNull();
    expect(candidate.setup).not.toBeNull();
    expect(candidate.setup!.initialStop).toBeLessThan(candidate.setup!.entryPrice);
    expect(candidate.setup!.entryPrice).toBeLessThan(candidate.setup!.tp1);
    expect(candidate.setup!.tp1).toBeLessThan(candidate.setup!.tp2);
    expect(candidate.setup!.tp2).toBeLessThan(candidate.setup!.tp3);
    expect(candidate.setup).not.toHaveProperty('quantity');
    expect(candidate.setup).not.toHaveProperty('estimatedRisk');
  });

  it('creates correctly ordered SHORT levels from a confirmed bearish trend', async () => {
    const now = 241 * 60_000;
    const closedCandles = Array.from(
      { length: 240 },
      (_, index) => candle(200 - index * 0.1 - index ** 2 * 0.001, index),
    );
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(closedCandles.map(binanceRow)));
    const service = new BinanceMarketScannerService(
      { list: async () => snapshot(now, { price: closedCandles.at(-1)!.close, change: -2 }) },
      fetcher,
      () => now,
    );
    const result = await service.scan(config);
    const candidate = result.candidates[0]!;

    expect(candidate.status).toBe('READY');
    expect(candidate.side).toBe('SHORT');
    expect(candidate.ema.direction).toBe('BEARISH');
    expect(candidate.setup).not.toBeNull();
    expect(candidate.setup!.tp3).toBeLessThan(candidate.setup!.tp2);
    expect(candidate.setup!.tp2).toBeLessThan(candidate.setup!.tp1);
    expect(candidate.setup!.tp1).toBeLessThan(candidate.setup!.entryPrice);
    expect(candidate.setup!.entryPrice).toBeLessThan(candidate.setup!.initialStop);
    expect(candidate.setup).not.toHaveProperty('quantity');
    expect(candidate.setup).not.toHaveProperty('estimatedRisk');
  });

  it('returns WAIT when the last completed candle exceeds the configured age', async () => {
    const now = 280 * 60_000;
    const closedCandles = Array.from({ length: 240 }, (_, index) => candle(100 + index * 0.2, index));
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(closedCandles.map(binanceRow)));
    const service = new BinanceMarketScannerService({ list: async () => snapshot(now) }, fetcher, () => now);
    const result = await service.scan({ ...config, maxAgeSeconds: 180 });

    expect(result.status).toBe('DEGRADED');
    expect(result.candidates[0]?.status).toBe('STALE');
    expect(result.candidates[0]?.side).toBe('WAIT');
    expect(result.candidates[0]?.setup).toBeNull();
  });

  it('returns WAIT with an explicit provider warning rather than fabricated data', async () => {
    const now = 241 * 60_000;
    const fetcher: typeof fetch = async () => new Response('[]', { status: 429 });
    const service = new BinanceMarketScannerService({ list: async () => snapshot(now) }, fetcher, () => now);
    const result = await service.scan(config);

    expect(result.status).toBe('DEGRADED');
    expect(result.candidates[0]?.status).toBe('DATA_UNAVAILABLE');
    expect(result.candidates[0]?.side).toBe('WAIT');
    expect(result.candidates[0]?.setup).toBeNull();
    expect(result.candidates[0]?.warnings[0]).toContain('429');
  });

  it('provides technical analysis without paper-account risk settings', async () => {
    const now = 241 * 60_000;
    const candles = Array.from({ length: 240 }, (_, index) => candle(100 + index * 0.2, index));
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(candles.map(binanceRow)));
    const service = new BinanceMarketScannerService({ list: async () => snapshot(now) }, fetcher, () => now);
    const result = await service.scan(config);

    expect(result.candidates[0]?.side).toBe('LONG');
    expect(result.candidates[0]?.setup).not.toBeNull();
    expect(result.candidates[0]?.setup).not.toHaveProperty('quantity');
  });

  it('includes top gainers and losers alongside the volume-ranked pool', async () => {
    const now = 241 * 60_000;
    const markets = snapshot(now).symbols[0]!;
    const marketList: FuturesMarketSnapshot = {
      ...snapshot(now),
      symbols: [
        {
          ...markets,
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteVolume24h: 50_000_000,
          priceChangePercent24h: 1,
        },
        {
          ...markets,
          symbol: 'GAINUSDT',
          baseAsset: 'GAIN',
          quoteVolume24h: 20_000_000,
          priceChangePercent24h: 25,
        },
        {
          ...markets,
          symbol: 'LOSSUSDT',
          baseAsset: 'LOSS',
          quoteVolume24h: 15_000_000,
          priceChangePercent24h: -20,
        },
      ],
    };
    const candles = Array.from({ length: 240 }, (_, index) => candle(100 + index * 0.2, index));
    const service = new BinanceMarketScannerService(
      { list: async () => marketList },
      async () => new Response(JSON.stringify(candles.map(binanceRow))),
      () => now,
    );
    const result = await service.scan({ ...config, limit: 1 });
    const candidates = new Map(result.candidates.map((candidate) => [candidate.symbol, candidate]));

    expect(candidates.size).toBe(3);
    expect(candidates.get('BTCUSDT')?.marketRank).toContain('TOP_VOLUME');
    expect(candidates.get('GAINUSDT')?.marketRank).toContain('TOP_GAINER');
    expect(candidates.get('LOSSUSDT')?.marketRank).toContain('TOP_LOSER');
  });
});
