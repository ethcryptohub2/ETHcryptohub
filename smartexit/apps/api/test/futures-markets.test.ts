import { describe, expect, it, vi } from 'vitest';
import {
  BinanceFuturesMarketsService,
  BinanceMarketDataError,
  BybitLinearFuturesMarketsService,
  PublicFuturesMarketsService,
  parseBinanceUsdtPerpetuals,
  type FuturesMarketSnapshot,
  type FuturesMarketsProvider,
} from '../src/services/binance-futures-markets.js';

describe('public futures market providers', () => {
  it('uses the Binance Futures exchange catalog and imports only eligible USDT perpetuals', async () => {
    const contracts = [
      { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', onboardDate: 1 },
      { symbol: 'BTCUSDC', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDC', onboardDate: 1 },
      { symbol: 'BTCUSDT_2606', status: 'TRADING', contractType: 'CURRENT_QUARTER', baseAsset: 'BTC', quoteAsset: 'USDT', onboardDate: 1 },
      { symbol: 'ETHUSDT', status: 'SETTLING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT', onboardDate: 2 },
      { symbol: '币安人生USDT', status: 'PENDING_TRADING', contractType: 'PERPETUAL', baseAsset: '币安人生', quoteAsset: 'USDT', onboardDate: 4 },
      ...Array.from({ length: 40 }, (_, index) => ({
        symbol: `COIN${index}USDT`,
        status: 'TRADING',
        contractType: 'PERPETUAL',
        baseAsset: `COIN${index}`,
        quoteAsset: 'USDT',
        onboardDate: 3,
      })),
    ];
    const catalog = parseBinanceUsdtPerpetuals({ symbols: contracts });
    expect(catalog).toHaveLength(43);
    expect(catalog.map(({ symbol }) => symbol)).toContain('币安人生USDT');
    expect(catalog.find(({ symbol }) => symbol === '币安人生USDT')?.status).toBe('PENDING_TRADING');
    expect(catalog.map(({ symbol }) => symbol)).not.toContain('BTCUSDC');
    expect(catalog.map(({ symbol }) => symbol)).not.toContain('BTCUSDT_2606');

    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('exchangeInfo')) return Response.json({ symbols: contracts });
      return Response.json(contracts.filter((contract) => contract.status === 'TRADING').map((contract) => ({
        symbol: contract.symbol,
        lastPrice: '1',
        priceChangePercent: '0',
        quoteVolume: '1000000',
        count: 1,
      })));
    });
    const result = await new BinanceFuturesMarketsService(request).list();
    expect(result.exchange).toBe('BINANCE');
    expect(result.symbols).toHaveLength(41);
    expect(result.symbols.every((contract) => contract.quoteAsset === 'USDT' && contract.contractType === 'PERPETUAL')).toBe(true);
  });

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
