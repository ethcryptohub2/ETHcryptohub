import fs from 'node:fs';
import path from 'node:path';

const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';

function calculateEma(values, period) {
  if (!values || values.length < period) return null;
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRsi(candles, period = 14) {
  if (!candles || candles.length <= period) return null;
  const changes = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }
  let gain = changes.slice(0, period).reduce((s, c) => s + Math.max(c, 0), 0) / period;
  let loss = changes.slice(0, period).reduce((s, c) => s + Math.max(-c, 0), 0) / period;
  for (let i = period; i < changes.length; i++) {
    gain = (gain * (period - 1) + Math.max(changes[i], 0)) / period;
    loss = (loss * (period - 1) + Math.max(-changes[i], 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - (100 / (1 + gain / loss));
}

function calculateAtr(candles, period = 10) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (!candles || candles.length < period + 1) return null;
  const atr = calculateAtr(candles, period);
  if (!atr) return null;
  const last = candles[candles.length - 1];
  const hl2 = (last.high + last.low) / 2;
  const upper = hl2 + multiplier * atr;
  const lower = hl2 - multiplier * atr;
  const direction = last.close > upper ? 'BULLISH' : last.close < lower ? 'BEARISH' : 'NEUTRAL';
  return { direction, atr, upper, lower };
}

function calculateMacd(candles, fast = 12, slow = 26, signalPeriod = 9) {
  if (!candles || candles.length < slow + signalPeriod) return null;
  const closes = candles.map(c => c.close);
  const fastEma = [];
  const slowEma = [];
  
  let f = closes.slice(0, fast).reduce((s, v) => s + v, 0) / fast;
  const kFast = 2 / (fast + 1);
  for (let i = 0; i < closes.length; i++) {
    if (i >= fast) f = closes[i] * kFast + f * (1 - kFast);
    fastEma.push(i >= fast - 1 ? f : null);
  }

  let s = closes.slice(0, slow).reduce((s, v) => s + v, 0) / slow;
  const kSlow = 2 / (slow + 1);
  for (let i = 0; i < closes.length; i++) {
    if (i >= slow) s = closes[i] * kSlow + s * (1 - kSlow);
    slowEma.push(i >= slow - 1 ? s : null);
  }

  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      macdLine.push(fastEma[i] - slowEma[i]);
    }
  }

  if (macdLine.length < signalPeriod) return null;
  let sig = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  const kSig = 2 / (signalPeriod + 1);
  for (let i = signalPeriod; i < macdLine.length; i++) {
    sig = macdLine[i] * kSig + sig * (1 - kSig);
  }
  const line = macdLine[macdLine.length - 1];
  return { line, signal: sig, histogram: line - sig };
}

function calculateAdx(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;
  const plusDm = [];
  const minusDm = [];
  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }

  let trSmooth = trs.slice(0, period).reduce((s, v) => s + v, 0);
  let plusDmSmooth = plusDm.slice(0, period).reduce((s, v) => s + v, 0);
  let minusDmSmooth = minusDm.slice(0, period).reduce((s, v) => s + v, 0);

  const dxList = [];
  for (let i = period; i < trs.length; i++) {
    trSmooth = trSmooth - (trSmooth / period) + trs[i];
    plusDmSmooth = plusDmSmooth - (plusDmSmooth / period) + plusDm[i];
    minusDmSmooth = minusDmSmooth - (minusDmSmooth / period) + minusDm[i];

    const plusDi = trSmooth > 0 ? (plusDmSmooth / trSmooth) * 100 : 0;
    const minusDi = trSmooth > 0 ? (minusDmSmooth / trSmooth) * 100 : 0;
    const diff = Math.abs(plusDi - minusDi);
    const sum = plusDi + minusDi;
    dxList.push(sum === 0 ? 0 : (diff / sum) * 100);
  }

  if (dxList.length < period) return null;
  let adx = dxList.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }
  return adx;
}

async function fetchWithRetry(url, maxRetries = 3) {
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers.get('retry-after') || 2) * 1000;
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 200 * (2 ** i)));
    }
  }
  throw lastErr;
}

export async function runFullUniverseScanner({
  minVolumeUsdt = 10_000_000,
  candleLimit = 400,
  batchConcurrency = 10,
  batchDelayMs = 250
} = {}) {
  const startTime = Date.now();
  console.log('================================================================');
  console.log('SMARTEXIT FULL-UNIVERSE MARKET SCANNER AUDIT');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Config: MinVolume: $${minVolumeUsdt.toLocaleString()} USDT | Candles: ${candleLimit} | Concurrency: ${batchConcurrency}`);
  console.log('================================================================');

  // Step 1: Dynamic discovery of exchange metadata
  console.log('\n[1/4] Querying live Binance USD-M Futures exchange metadata...');
  const exchangeInfo = await fetchWithRetry(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`);
  const totalDiscoveredSymbols = exchangeInfo.symbols.length;
  
  const activeUsdtPerpetuals = exchangeInfo.symbols.filter(s => 
    s.quoteAsset === 'USDT' && 
    s.contractType === 'PERPETUAL' && 
    s.status === 'TRADING'
  );
  console.log(`- Total contracts in exchange registry: ${totalDiscoveredSymbols}`);
  console.log(`- Active TRADING USDT perpetuals: ${activeUsdtPerpetuals.length}`);

  // Step 2: 24hr Ticker volume and liquidity scan
  console.log('\n[2/4] Querying 24hr ticker data for volume filtering...');
  const tickers = await fetchWithRetry(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/24hr`);
  const tickerMap = new Map();
  for (const t of tickers) {
    tickerMap.set(t.symbol, {
      lastPrice: parseFloat(t.lastPrice),
      quoteVolume: parseFloat(t.quoteVolume),
      priceChangePercent: parseFloat(t.priceChangePercent)
    });
  }

  // Filter pairs meeting configured liquidity threshold
  const liquidPairs = activeUsdtPerpetuals.filter(s => {
    const t = tickerMap.get(s.symbol);
    return t && t.quoteVolume >= minVolumeUsdt;
  });

  console.log(`- Symbols meeting volume threshold (>= $${minVolumeUsdt.toLocaleString()} USDT): ${liquidPairs.length} / ${activeUsdtPerpetuals.length}`);
  console.log(`- Filtered out due to sub-threshold liquidity: ${activeUsdtPerpetuals.length - liquidPairs.length}`);

  // Sort descending by 24h quote volume
  liquidPairs.sort((a, b) => (tickerMap.get(b.symbol)?.quoteVolume ?? 0) - (tickerMap.get(a.symbol)?.quoteVolume ?? 0));

  // Step 3: Scan EVERY symbol passing liquidity filter (no arbitrary limit!)
  console.log(`\n[3/4] Technical indicator calculation for all ${liquidPairs.length} liquid symbols...`);
  console.log(`- Fetching ${candleLimit} candles per symbol (full mathematical warm-up for EMA200)...`);

  let scannedCount = 0;
  let filteredCount = 0;
  let failedCount = 0;
  const failureReasons = [];
  const qualifiedStandard = [];
  const qualifiedHighRisk = [];

  for (let i = 0; i < liquidPairs.length; i += batchConcurrency) {
    const batch = liquidPairs.slice(i, i + batchConcurrency);
    await Promise.all(batch.map(async (inst) => {
      try {
        const url = `${BINANCE_FUTURES_BASE_URL}/fapi/v1/klines?symbol=${inst.symbol}&interval=1h&limit=${candleLimit}`;
        const rawKlines = await fetchWithRetry(url);
        scannedCount++;

        if (!Array.isArray(rawKlines) || rawKlines.length < 200) {
          filteredCount++;
          failureReasons.push({ symbol: inst.symbol, reason: 'Insufficient candle history for EMA200 (< 200 bars)' });
          return;
        }

        const candles = rawKlines.map(k => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6]
        }));

        const closes = candles.map(c => c.close);
        const ema9 = calculateEma(closes, 9);
        const ema21 = calculateEma(closes, 21);
        const ema50 = calculateEma(closes, 50);
        const ema200 = calculateEma(closes, 200);
        const rsi = calculateRsi(candles, 14);
        const macd = calculateMacd(candles);
        const adx = calculateAdx(candles);
        const supertrend = calculateSupertrend(candles);
        const currentPrice = closes[closes.length - 1];

        if (!ema9 || !ema21 || !ema50 || !ema200 || !rsi || !macd || !adx || !supertrend) {
          filteredCount++;
          failureReasons.push({ symbol: inst.symbol, reason: 'Indicator calculation incomplete' });
          return;
        }

        // Standard Strategy: Trend Alignment & Confluence
        const isStandardLong = (ema9 > ema21 && ema21 > ema50 && currentPrice > ema200 && supertrend.direction === 'BULLISH' && adx > 20 && rsi > 50 && rsi < 70);
        const isStandardShort = (ema9 < ema21 && ema21 < ema50 && currentPrice < ema200 && supertrend.direction === 'BEARISH' && adx > 20 && rsi < 50 && rsi > 30);

        if (isStandardLong || isStandardShort) {
          const side = isStandardLong ? 'LONG' : 'SHORT';
          const atr = supertrend.atr;
          const stopLoss = side === 'LONG' ? currentPrice - (1.5 * atr) : currentPrice + (1.5 * atr);
          const tp1 = side === 'LONG' ? currentPrice + (1.5 * atr) : currentPrice - (1.5 * atr);
          const tp2 = side === 'LONG' ? currentPrice + (2.5 * atr) : currentPrice - (2.5 * atr);
          const tp3 = side === 'LONG' ? currentPrice + (4.0 * atr) : currentPrice - (4.0 * atr);
          const riskReward = Math.abs(tp3 - currentPrice) / Math.abs(currentPrice - stopLoss);

          qualifiedStandard.push({
            symbol: inst.symbol,
            side,
            currentPrice,
            strategy: 'STANDARD',
            ema9, ema21, ema50, ema200,
            rsi: Number(rsi.toFixed(1)),
            adx: Number(adx.toFixed(1)),
            supertrend: supertrend.direction,
            atr: Number(atr.toFixed(4)),
            setup: {
              entryPrice: currentPrice,
              initialStop: Number(stopLoss.toFixed(4)),
              tp1: Number(tp1.toFixed(4)),
              tp2: Number(tp2.toFixed(4)),
              tp3: Number(tp3.toFixed(4)),
              riskReward: Number(riskReward.toFixed(2))
            },
            rationale: `${side} trend confluence: EMA stack aligned, price ${isStandardLong ? 'above' : 'below'} EMA200, Supertrend ${supertrend.direction}, ADX ${adx.toFixed(1)} > 20, RSI ${rsi.toFixed(1)}`,
            confidenceScore: 88,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            executionEligible: true
          });
        }

        // High-Risk Strategy: Momentum Divergence & Volatility Breakout
        const isHighRiskLong = (rsi < 30 && macd.histogram > 0);
        const isHighRiskShort = (rsi > 70 && macd.histogram < 0);

        if (isHighRiskLong || isHighRiskShort) {
          const side = isHighRiskLong ? 'LONG' : 'SHORT';
          const atr = supertrend.atr;
          const stopLoss = side === 'LONG' ? currentPrice - (1.0 * atr) : currentPrice + (1.0 * atr);
          const tp1 = side === 'LONG' ? currentPrice + (1.0 * atr) : currentPrice - (1.0 * atr);
          const tp2 = side === 'LONG' ? currentPrice + (2.0 * atr) : currentPrice - (2.0 * atr);
          const tp3 = side === 'LONG' ? currentPrice + (3.0 * atr) : currentPrice - (3.0 * atr);
          const riskReward = Math.abs(tp3 - currentPrice) / Math.abs(currentPrice - stopLoss);

          qualifiedHighRisk.push({
            symbol: inst.symbol,
            side,
            currentPrice,
            strategy: 'HIGH_RISK_SCALPING',
            rsi: Number(rsi.toFixed(1)),
            macdHistogram: Number(macd.histogram.toFixed(4)),
            atr: Number(atr.toFixed(4)),
            setup: {
              entryPrice: currentPrice,
              initialStop: Number(stopLoss.toFixed(4)),
              tp1: Number(tp1.toFixed(4)),
              tp2: Number(tp2.toFixed(4)),
              tp3: Number(tp3.toFixed(4)),
              riskReward: Number(riskReward.toFixed(2))
            },
            rationale: `${side} mean-reversion setup: RSI ${rsi.toFixed(1)} in extreme zone with MACD histogram momentum reversal (${macd.histogram.toFixed(4)})`,
            confidenceScore: 78,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            executionEligible: true
          });
        }

        if (!isStandardLong && !isStandardShort && !isHighRiskLong && !isHighRiskShort) {
          filteredCount++;
        }
      } catch (err) {
        failedCount++;
        failureReasons.push({ symbol: inst.symbol, reason: err instanceof Error ? err.message : String(err) });
      }
    }));

    // Rate-limit safe throttling
    if (i + batchConcurrency < liquidPairs.length) {
      await new Promise(r => setTimeout(r, batchDelayMs));
    }
  }

  const durationMs = Date.now() - startTime;
  console.log('\n[4/4] Scan complete!');
  console.log('----------------------------------------------------------------');
  console.log(`Total Discovered Symbols: ${totalDiscoveredSymbols}`);
  console.log(`Active TRADING Perpetuals: ${activeUsdtPerpetuals.length}`);
  console.log(`Liquidity Filter (>= $${minVolumeUsdt.toLocaleString()} USDT): ${liquidPairs.length} eligible`);
  console.log(`Technically Scanned Symbols: ${scannedCount}`);
  console.log(`Filtered (No Confluence): ${filteredCount}`);
  console.log(`Failed (Network/Data Errors): ${failedCount}`);
  console.log(`Qualified Standard Signals: ${qualifiedStandard.length}`);
  console.log(`Qualified High-Risk Signals: ${qualifiedHighRisk.length}`);
  console.log(`Total Scan Duration: ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)`);
  console.log('----------------------------------------------------------------');

  const auditReport = {
    scannedAt: new Date().toISOString(),
    durationMs,
    totalDiscoveredSymbols,
    activeUsdtPerpetualsCount: activeUsdtPerpetuals.length,
    minVolumeThresholdUsdt: minVolumeUsdt,
    liquidEligibleCount: liquidPairs.length,
    technicallyScannedCount: scannedCount,
    filteredCount,
    failedCount,
    failureReasons: failureReasons.slice(0, 10),
    qualifiedStandard,
    qualifiedHighRisk
  };

  const outputPath = path.join(process.cwd(), 'tmp', 'verified-market-scan-audit.json');
  fs.writeFileSync(outputPath, JSON.stringify(auditReport, null, 2));
  console.log(`Saved audit report to ${outputPath}`);

  return auditReport;
}

if (process.argv[1]?.endsWith('verify-full-market-scan.mjs')) {
  runFullUniverseScanner().catch(console.error);
}
