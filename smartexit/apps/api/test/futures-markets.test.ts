import { describe, expect, it, vi } from 'vitest';
import {
  BinanceMarketDataError,
  BybitLinearFuturesMarketsService,
  PublicFuturesMarketsService,
  type FuturesMarketSnapshot,
  type FuturesMarketsProvider,
} from '../src/services/binance-futures-markets.js';

describe('public futures market providers', () => {
  it('loads only active USDT linear perpetuals and maps public tickers', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/instruments-info')) {
        return Response.json({
          retCode: 0,
          result: {
            nextPageCursor: '',
            list: [
              { symbol: 'BTCUSDT', status: 'Trading', contractType: 'LinearPerpetual', baseCoin: 'BTC', quoteCoin: 'USDT' },
              { symbol: 'BTCUSDC', status: 'Trading', contractType: 'LinearPerpetual', baseCoin: 'BTC', quoteCoin: 'USDC' },
              { symbol: 'BTCUSDT', status: 'Trading', contractType: 'LinearFutures', baseCoin: 'BTC', quoteCoin: 'USDT' },
            ],
          },
        });
      }
      return Response.json({
        retCode: 0,
        result: {
          list: [{ symbol: 'BTCUSDT', lastPrice: '65000', price24hPcnt: '0.025', turnover24h: '123456789' }],
        },
      });
    });
    const service = new BybitLinearFuturesMarketsService(request);

    const result = await service.list();

    expect(result.exchange).toBe('BYBIT');
    expect(result.market).toBe('USDT LINEAR PERPETUALS');
    expect(result.symbols).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        lastPrice: 65000,
        priceChangePercent24h: 2.5,
        quoteVolume24h: 123456789,
      }),
    ]);
  });

  it('uses the secondary public provider when the preferred provider is unavailable', async () => {
    const snapshot: FuturesMarketSnapshot = {
      exchange: 'BINANCE',
      market: 'USDⓈ-M FUTURES',
      source: 'test fixture',
      updatedAt: new Date().toISOString(),
      symbols: [],
    };
    const primary: FuturesMarketsProvider = {
      list: async () => { throw new BinanceMarketDataError('primary unavailable'); },
    };
    const fallback: FuturesMarketsProvider = { list: async () => snapshot };

    await expect(new PublicFuturesMarketsService(primary, fallback).list()).resolves.toBe(snapshot);
  });

  it('reports both providers unavailable instead of returning incomplete data', async () => {
    const unavailable: FuturesMarketsProvider = {
      list: async () => { throw new BinanceMarketDataError('feed unavailable'); },
    };

    await expect(new PublicFuturesMarketsService(unavailable, unavailable).list())
      .rejects.toThrow('Public futures data is unavailable');
  });
});
