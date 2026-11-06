import { describe, expect, it } from 'vitest';
import {
  ConfiguredMarketResearchProvider,
  emptyMarketResearch,
} from '../src/services/market-research.js';

describe('market research provider', () => {
  it('marks unset optional providers as unavailable instead of inventing research values', () => {
    const result = emptyMarketResearch();

    expect(result.liquidationHeatmap.status).toBe('NOT_CONFIGURED');
    expect(result.onChainFlow.status).toBe('NOT_CONFIGURED');
    expect(result.news.status).toBe('NOT_CONFIGURED');
    expect(result.derivatives.data).toBeNull();
  });

  it('loads exchange metrics, liquidation levels, exchange flow, and news-vote context', async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/funding/history')) {
        return Response.json({ retCode: 0, result: { list: [{ fundingRate: '0.0001' }] } });
      }
      if (url.pathname.endsWith('/open-interest')) {
        return Response.json({
          retCode: 0,
          result: { list: [{ openInterest: '110', timestamp: '2' }, { openInterest: '100', timestamp: '1' }] },
        });
      }
      if (url.pathname.endsWith('/heatmap/model1')) {
        return Response.json({
          code: '0',
          data: {
            y_axis: [90, 110],
            liquidation_leverage_data: [[0, 0, 50], [1, 1, 80]],
          },
        });
      }
      if (url.pathname.endsWith('/transfers_volume_exchanges_net')) {
        return Response.json([{ t: 1, v: -12.5 }]);
      }
      if (url.pathname.endsWith('/posts/')) {
        return Response.json({
          results: [{
            title: 'Market update',
            url: 'https://news.example/market',
            published_at: '2026-11-06T00:00:00Z',
            votes: { positive: 3, negative: 1 },
          }],
        });
      }
      return new Response('Not found', { status: 404 });
    };
    const provider = new ConfiguredMarketResearchProvider({
      glassnode: 'glassnode-test-key',
      cryptopanic: 'cryptopanic-test-key',
      coinglass: 'coinglass-test-key',
    }, request);

    const result = await provider.getResearch({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      exchange: 'BYBIT',
      timeframe: '15m',
      price: 100,
    });

    expect(result.derivatives.status).toBe('LIVE');
    expect(result.derivatives.data?.fundingRatePercent).toBeCloseTo(0.01);
    expect(result.derivatives.data?.openInterestChangePercent).toBeCloseTo(10);
    expect(result.liquidationHeatmap.data?.nearestBelow?.price).toBe(90);
    expect(result.liquidationHeatmap.data?.nearestAbove?.price).toBe(110);
    expect(result.onChainFlow.data?.exchangeNetflow).toBe(-12.5);
    expect(result.news.data?.positiveVotes).toBe(3);
    expect(result.news.data?.negativeVotes).toBe(1);
  });

  it('falls back to Binance funding and open-interest history when Bybit data is unavailable', async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.bybit.com') return new Response('unavailable', { status: 503 });
      if (url.pathname.endsWith('/fundingRate')) {
        return Response.json([{ fundingRate: '0.0002' }]);
      }
      if (url.pathname.endsWith('/openInterestHist')) {
        return Response.json([
          { sumOpenInterestValue: '100', timestamp: 1 },
          { sumOpenInterestValue: '120', timestamp: 2 },
        ]);
      }
      return new Response('Not found', { status: 404 });
    };
    const provider = new ConfiguredMarketResearchProvider({
      glassnode: null,
      cryptopanic: null,
      coinglass: null,
    }, request);

    const result = await provider.getResearch({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      exchange: 'BYBIT',
      timeframe: '15m',
      price: 100,
    });

    expect(result.derivatives.status).toBe('LIVE');
    expect(result.derivatives.source).toContain('BINANCE');
    expect(result.derivatives.data?.fundingRatePercent).toBeCloseTo(0.02);
    expect(result.derivatives.data?.openInterestChangePercent).toBeCloseTo(20);
  });
});
