import { BinanceMarketScannerService, parseCandles } from '../smartexit/apps/api/src/services/market-scanner';
import type { FuturesMarketSnapshot } from '../smartexit/apps/api/src/services/binance-futures-markets';
import { analyzeHighRiskScalpingSetup } from './high-risk-scalping';
import type { HighRiskScalpingSettings } from './high-risk-scalping-types';

type HistoricalInput = {
  asOf: number;
  eligibleAt: number;
  eligibleUntil: number | null;
  market: FuturesMarketSnapshot;
  candles: readonly unknown[];
  minimumStandardScore: number;
  highRiskSettings: HighRiskScalpingSettings;
} & ({ strategy: 'STANDARD'; timeframe: '15m' } |
  { strategy: 'HIGH_RISK'; timeframe: '5m'; btcContext: { observedAt: number; changePercent: number } });

export async function qualifyHistoricalSignal(input: HistoricalInput) {
  const { asOf, eligibleAt, eligibleUntil, market, timeframe } = input;
  const size = timeframe === '15m' ? 900_000 : 300_000;
  const observedAt = Date.parse(market.updatedAt);
  const instrument = market.symbols[0];
  if (![asOf, eligibleAt, observedAt].every(value => Number.isSafeInteger(value) && value >= 0) ||
      eligibleAt > asOf || (eligibleUntil !== null && (!Number.isSafeInteger(eligibleUntil) || asOf >= eligibleUntil)) ||
      observedAt > asOf || asOf - observedAt > size || market.symbols.length !== 1 || !instrument ||
      !/^[A-Z0-9]{1,20}USDT$/.test(instrument.symbol) || instrument.quoteAsset !== 'USDT' ||
      instrument.contractType !== 'PERPETUAL' || instrument.lastPrice === null || instrument.lastPrice <= 0 ||
      instrument.quoteVolume24h < 0 || instrument.tradeCount24h < 0 ||
      ![instrument.lastPrice, instrument.quoteVolume24h, instrument.priceChangePercent24h, instrument.tradeCount24h].every(Number.isFinite)) {
    throw new RangeError('Point-in-time market metadata is invalid or unavailable.');
  }
  if (!input.candles.every(row => Array.isArray(row) && Number.isSafeInteger(row[6]))) {
    throw new RangeError('Historical candle timestamps are invalid.');
  }
  const raw = input.candles.filter(row => Array.isArray(row) && row[6] < asOf);
  const closed = parseCandles(raw);
  if (!closed || closed.length < 200 || closed.length > 400 || closed.length !== raw.length ||
      closed.at(-1)?.closeTime !== Math.floor(asOf / size) * size - 1 ||
      closed.some((bar, index) => !Number.isSafeInteger(bar.openTime) || bar.openTime < 0 ||
        bar.openTime % size !== 0 || bar.closeTime !== bar.openTime + size - 1 ||
        bar.low <= 0 || bar.low > bar.close || bar.close > bar.high || bar.volume < 0 ||
        (index > 0 && bar.openTime !== closed[index - 1]!.openTime + size))) {
    throw new RangeError('Historical qualification requires contiguous and fully closed candles.');
  }

  if (input.strategy === 'HIGH_RISK') {
    const { btcContext, highRiskSettings } = input;
    if (!Number.isSafeInteger(btcContext.observedAt) || btcContext.observedAt < 0 || btcContext.observedAt > asOf ||
        asOf - btcContext.observedAt > size || !Number.isFinite(btcContext.changePercent)) {
      throw new RangeError('Point-in-time BTC context is invalid or unavailable.');
    }
    const btcDirection = btcContext.changePercent > 0.2 ? 'BULLISH' : btcContext.changePercent < -0.2 ? 'BEARISH' : 'NEUTRAL';
    const setup = highRiskSettings.enabled && highRiskSettings.enabledTimeframes.includes('5m') &&
      instrument.quoteVolume24h >= highRiskSettings.minimumQuoteVolume
      ? analyzeHighRiskScalpingSetup({ symbol: instrument.symbol, timeframe, candles: closed,
        price: instrument.lastPrice, btcDirection, settings: highRiskSettings, now: asOf }) : null;
    return { strategy: input.strategy, setup };
  }

  const scanner = new BinanceMarketScannerService({ list: async () => market }, async request => {
    const url = new URL(String(request));
    if (url.pathname !== '/fapi/v1/klines' || url.searchParams.get('symbol') !== instrument.symbol ||
        url.searchParams.get('interval') !== timeframe) throw new Error('Unexpected historical market request.');
    return Response.json(raw);
  }, () => asOf);
  const result = await scanner.scan({
    quoteAsset: 'USDT', timeframe, symbols: [instrument.symbol], minimumVolume: 10_000_000,
    limit: 1, atrPeriod: 10, multiplier: 3, maxAgeSeconds: size / 1000, minimumScore: input.minimumStandardScore,
  });
  return { strategy: input.strategy, candidate: result.candidates[0] ?? null };
}
