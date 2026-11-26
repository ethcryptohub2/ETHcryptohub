import type { NormalizedCandle, ProviderTimeframe } from '../provider-types';

/**
 * CryptoDataDownload Provider Adapter (Provider 3 Candidate)
 *
 * Evaluation Status:
 * CryptoDataDownload free endpoints provide daily/hourly historical CSVs and summary data,
 * NOT real-time 5m/15m live Binance USD-M Futures candles across 520+ perpetual contracts.
 * Per architecture safety rules, this adapter is strictly marked historical-only and
 * disabled as a live failover provider by default.
 */
const CDD_BASE_URL = 'https://api.cryptodatadownload.com/v1/data/ohlc';

export async function fetchCryptoDataDownloadHistoricalCandles(
  symbol: string,
  timeframe: ProviderTimeframe,
  request: typeof fetch = globalThis.fetch,
): Promise<NormalizedCandle[]> {
  if (timeframe !== '1h' && timeframe !== '4h') {
    throw new Error(`CryptoDataDownload free adapter does not support live sub-hourly ${timeframe} futures candles.`);
  }
  const url = `${CDD_BASE_URL}/binance/${symbol.toLowerCase()}/${timeframe}/`;
  const response = await request(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const err = new Error(`CryptoDataDownload request failed (${response.status}) for ${symbol}.`);
    (err as Error & { statusCode?: number }).statusCode = response.status;
    throw err;
  }
  const body = (await response.json()) as {
    result?: Array<{
      unix?: number;
      open?: number;
      high?: number;
      low?: number;
      close?: number;
      volume?: number;
    }>;
  };
  if (!Array.isArray(body.result)) {
    throw new Error('CryptoDataDownload returned invalid OHLC payload.');
  }
  const intervalMs = timeframe === '1h' ? 3_600_000 : 14_400_000;
  return body.result
    .map((r) => {
      const openTime = Number(r.unix) * 1000;
      const open = Number(r.open);
      const high = Number(r.high);
      const low = Number(r.low);
      const close = Number(r.close);
      const volume = Number(r.volume);
      if (![openTime, open, high, low, close, volume].every(Number.isFinite) || high < low || close <= 0) {
        return null;
      }
      return {
        openTime,
        open,
        high,
        low,
        close,
        volume,
        closeTime: openTime + intervalMs - 1,
        isClosed: true,
      };
    })
    .filter((c): c is NormalizedCandle => c !== null)
    .sort((a, b) => a.openTime - b.openTime);
}
