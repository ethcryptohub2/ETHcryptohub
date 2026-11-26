import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { binanceRateLimiter } from '../lib/binance-rate-limit.ts';
import { sharedCandleCache, timeframeToMs } from '../lib/candle-cache.ts';
import {
  AllMarketDataProvidersUnavailableError,
  bootstrapHistoryFromBinanceVision,
  fetchCandlesWithFailover,
  validateCandleSeriesFreshness,
} from '../lib/market-data/provider-manager.ts';
import {
  coinapiTracker,
  resetAllProviderTrackers,
} from '../lib/market-data/provider-registry.ts';
import { toCoinApiPeriod, toCoinApiSymbolId } from '../lib/market-data/providers/coinapi.ts';
import {
  extractFirstCsvFromZipBuffer,
  parseBinanceVisionCsv,
  resetBinanceVisionArchiveLog,
} from '../lib/market-data/providers/binance-vision.ts';

function buildZipBuffer(filename, contentText) {
  const nameBuf = Buffer.from(filename, 'utf8');
  const compressed = deflateRawSync(Buffer.from(contentText, 'utf8'));
  const header = Buffer.alloc(30 + nameBuf.length);
  header.writeUInt32LE(0x04034b50, 0); // PKZIP signature
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(Buffer.byteLength(contentText, 'utf8'), 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  nameBuf.copy(header, 30);
  return Buffer.concat([header, compressed]);
}

const baseConfig = {
  autoFailoverEnabled: true,
  binanceEnabled: true,
  coinapiEnabled: true,
  coinapiApiKey: 'test-coinapi-key-1234',
  alternativeEnabled: false,
  historicalCacheEnabled: true,
};

test('CoinAPI symbol and timeframe mapping enforces BINANCEFTS USD-M perpetuals', () => {
  assert.equal(toCoinApiSymbolId('BTCUSDT'), 'BINANCEFTS_PERP_BTC_USDT');
  assert.equal(toCoinApiSymbolId('solusdt'), 'BINANCEFTS_PERP_SOL_USDT');
  assert.equal(toCoinApiPeriod('5m'), '5MIN');
  assert.equal(toCoinApiPeriod('15m'), '15MIN');
  assert.equal(toCoinApiPeriod('1h'), '1HRS');
  assert.equal(toCoinApiPeriod('4h'), '4HRS');
  assert.throws(() => toCoinApiSymbolId('BTCUSD'));
});

test('Automatic Failover: Binance HTTP 418 trips circuit breaker and fails over seamlessly to CoinAPI', async () => {
  binanceRateLimiter.reset();
  resetAllProviderTrackers();
  sharedCandleCache.clear();
  const now = Date.now();
  const intervalMs = timeframeToMs('15m');
  const open1 = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const open0 = open1 - intervalMs;

  const mockFetch = async (input) => {
    const url = String(input);
    if (url.includes('fapi.binance.com')) {
      return new Response('{"code":-1003,"msg":"IP banned"}', {
        status: 418,
        headers: { 'retry-after': '120' },
      });
    }
    if (url.includes('rest.coinapi.io')) {
      assert.ok(url.includes('BINANCEFTS_PERP_BTC_USDT'));
      return new Response(
        JSON.stringify([
          {
            time_period_start: new Date(open0).toISOString(),
            time_period_end: new Date(open0 + intervalMs).toISOString(),
            price_open: 94000,
            price_high: 94500,
            price_low: 93800,
            price_close: 94200,
            volume_traded: 500,
          },
          {
            time_period_start: new Date(open1).toISOString(),
            time_period_end: new Date(open1 + intervalMs).toISOString(),
            price_open: 94200,
            price_high: 95100,
            price_low: 94100,
            price_close: 95000,
            volume_traded: 620,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await fetchCandlesWithFailover({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    config: baseConfig,
    request: mockFetch,
    now,
  });

  assert.equal(result.provider, 'coinapi');
  assert.equal(result.historicalOnly, false);
  assert.equal(result.isFresh, true);
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[1].close, 95000);
  assert.equal(binanceRateLimiter.getStatus(now).state, 'OPEN');

  binanceRateLimiter.reset();
  resetAllProviderTrackers();
});

test('All live providers unavailable returns sanitized AllMarketDataProvidersUnavailableError without leaking URLs or keys', async () => {
  binanceRateLimiter.reset();
  resetAllProviderTrackers();
  const now = Date.now();

  const failingFetch = async () => new Response('Forbidden', { status: 403 });

  await assert.rejects(
    () =>
      fetchCandlesWithFailover({
        symbol: 'ETHUSDT',
        timeframe: '15m',
        config: { ...baseConfig, coinapiApiKey: null },
        request: failingFetch,
        now,
      }),
    (err) => {
      assert.ok(err instanceof AllMarketDataProvidersUnavailableError);
      assert.equal(err.message, 'Market data temporarily unavailable. Automatic recovery in progress.');
      assert.ok(!err.message.includes('coinapi'));
      assert.ok(!err.message.includes('fapi.binance'));
      return true;
    },
  );

  binanceRateLimiter.reset();
  resetAllProviderTrackers();
});

test('CoinAPI daily quota exhaustion blocks further CoinAPI requests cleanly', async () => {
  binanceRateLimiter.reset();
  resetAllProviderTrackers();
  const now = Date.now();
  // Simulate 100/100 free daily requests used
  coinapiTracker.recordQuotaUse(100, now);
  assert.equal(coinapiTracker.hasQuota(1, now), false);
  assert.equal(coinapiTracker.isEligible(now), false);

  resetAllProviderTrackers();
});

test('Stale candle series validation rejects old or out-of-order candles', () => {
  const now = 1_795_700_000_000;
  const stale = [
    { openTime: now - 10_000_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closeTime: now - 9_100_000, isClosed: true },
  ];
  assert.equal(validateCandleSeriesFreshness(stale, '15m', now).valid, false);

  const outOfOrder = [
    { openTime: now - 900_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closeTime: now - 1, isClosed: true },
    { openTime: now - 1_800_000, open: 100, high: 101, low: 99, close: 100, volume: 10, closeTime: now - 900_001, isClosed: true },
  ];
  assert.equal(validateCandleSeriesFreshness(outOfOrder, '15m', now).valid, false);
});

test('Binance Vision ZIP archive extraction, CSV parsing, and duplicate archive skip', async () => {
  resetBinanceVisionArchiveLog();
  sharedCandleCache.clear();
  const csv = [
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    '1795651200000,95000.0,95200.0,94900.0,95100.0,120.5,1795652099999,11459550.0,1000,60.0,5700000.0,0',
    '1795652100000,95100.0,95300.0,95050.0,95250.0,140.0,1795652999999,13335000.0,1100,70.0,6667500.0,0',
  ].join('\n');

  const zipBuf = buildZipBuffer('BTCUSDT-15m-2026-11-25.csv', csv);
  const extracted = extractFirstCsvFromZipBuffer(zipBuf);
  const parsed = parseBinanceVisionCsv(extracted);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].open, 95000);
  assert.equal(parsed[1].close, 95250);

  let fetches = 0;
  const mockFetch = async () => {
    fetches += 1;
    return new Response(zipBuf, { status: 200 });
  };

  const first = await bootstrapHistoryFromBinanceVision({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    dateStr: '2026-11-25',
    request: mockFetch,
  });
  assert.equal(first.length, 2);
  assert.equal(fetches, 1);

  // Second call for same archive must skip re-downloading
  const second = await bootstrapHistoryFromBinanceVision({
    symbol: 'BTCUSDT',
    timeframe: '15m',
    dateStr: '2026-11-25',
    request: mockFetch,
  });
  assert.equal(second.length, 0);
  assert.equal(fetches, 1);

  resetBinanceVisionArchiveLog();
});
