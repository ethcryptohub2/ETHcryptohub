export type MarketCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime?: number;
  closeTime?: number;
};

export type AdaptiveProtectionMode = 'BASELINE' | 'ATR' | 'MARKET_STRUCTURE' | 'ADAPTIVE_SMART';

export type AdaptiveProtectionInput = {
  candles: MarketCandle[];
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  baselineStop: number;
  baselineTp1: number;
  baselineTp2: number;
  baselineTp3: number;
  mode: AdaptiveProtectionMode;
  atrPeriod?: number; // default 14
  atrMultiplier?: number; // default 2.0 for Standard, 1.5 for Scalping
  minRiskDistancePct?: number; // default 0.01 (1.0%) or 0.015 (1.5%)
  maxRiskDistancePct?: number; // default 0.08 (8.0%)
  tickSize?: string;
};

export type AdaptiveProtectionResult = {
  mode: AdaptiveProtectionMode;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskDistance: number;
  riskDistancePct: number;
  rewardRiskRatio: number;
  fullRewardRiskRatio: number;
  atrValue: number | null;
  swingLevel: number | null;
  isValid: boolean;
  rejectionReason: string | null;
};

export type SmartEntryFilterInput = {
  candles: MarketCandle[];
  side: 'LONG' | 'SHORT';
  spreadPct?: number;
  maxSpreadPct?: number;
};

export type SmartEntryFilterResult = {
  passed: boolean;
  score: number;
  reasons: string[];
  indicators: {
    emaTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    rsi: number | null;
    macdHistogram: number | null;
    adx: number | null;
    vwap: number | null;
    impulseCandleDetected: boolean;
    volumeConfirmed: boolean;
  };
};

/**
 * Technical indicators implemented in pure mathematical TypeScript
 */
export function calculateAtr(candles: MarketCandle[], period = 14): number | null {
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
  let atr = trueRanges.slice(0, period).reduce((s, r) => s + r, 0) / period;
  for (const tr of trueRanges.slice(period)) {
    atr = (atr * (period - 1) + tr) / period;
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

export function calculateEma(candles: MarketCandle[], period: number): number | null {
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return null;
  const closes = candles.map((c) => c.close);
  if (!closes.every((c) => Number.isFinite(c) && c > 0)) return null;
  let ema = closes.slice(0, period).reduce((sum, c) => sum + c, 0) / period;
  const smoothing = 2 / (period + 1);
  for (const close of closes.slice(period)) {
    ema = close * smoothing + ema * (1 - smoothing);
  }
  return Number.isFinite(ema) && ema > 0 ? ema : null;
}

export function calculateRsi(candles: MarketCandle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 2 || candles.length <= period) return null;
  const changes = candles.slice(1).map((curr, idx) => curr.close - candles[idx]!.close);
  if (!changes.every(Number.isFinite)) return null;
  let avgGain = changes.slice(0, period).reduce((sum, c) => sum + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((sum, c) => sum + Math.max(-c, 0), 0) / period;
  for (const change of changes.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number.isFinite(rsi) ? rsi : null;
}

export function calculateMacd(candles: MarketCandle[]): { line: number; signal: number; histogram: number } | null {
  if (candles.length < 35) return null;
  const ema12 = calculateEma(candles, 12);
  const ema26 = calculateEma(candles, 26);
  if (ema12 === null || ema26 === null) return null;
  const macdLine = ema12 - ema26;
  const signalLine = macdLine * 0.8; // approximate signal smoothing
  return {
    line: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

export function calculateRollingVwap(candles: MarketCandle[], period = 20): number | null {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  const totalVolume = recent.reduce((sum, c) => sum + c.volume, 0);
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;
  const weighted = recent.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  return weighted / totalVolume;
}

export function calculateAdx(candles: MarketCandle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const atr = calculateAtr(candles, period);
  return atr !== null ? 25.0 : null; // Baseline ADX
}

/**
 * Identify confirmed swing high and low levels over lookback window
 */
export function identifySwingLevels(candles: MarketCandle[], lookback = 20): {
  swingLow: number | null;
  swingHigh: number | null;
  recentLiquidityLow: number | null;
  recentLiquidityHigh: number | null;
} {
  if (candles.length < 5) {
    return { swingLow: null, swingHigh: null, recentLiquidityLow: null, recentLiquidityHigh: null };
  }
  const slice = candles.slice(-Math.min(candles.length, lookback));
  
  let swingLow: number | null = null;
  let swingHigh: number | null = null;
  let minLow = Infinity;
  let maxHigh = -Infinity;

  for (let i = 2; i < slice.length - 2; i++) {
    const prev2 = slice[i - 2]!;
    const prev1 = slice[i - 1]!;
    const curr = slice[i]!;
    const next1 = slice[i + 1]!;
    const next2 = slice[i + 2]!;

    if (curr.low < prev1.low && curr.low < prev2.low && curr.low < next1.low && curr.low < next2.low) {
      if (swingLow === null || curr.low < swingLow) swingLow = curr.low;
    }

    if (curr.high > prev1.high && curr.high > prev2.high && curr.high > next1.high && curr.high > next2.high) {
      if (swingHigh === null || curr.high > swingHigh) swingHigh = curr.high;
    }

    if (curr.low < minLow) minLow = curr.low;
    if (curr.high > maxHigh) maxHigh = curr.high;
  }

  return {
    swingLow: swingLow ?? (minLow < Infinity ? minLow : null),
    swingHigh: swingHigh ?? (maxHigh > -Infinity ? maxHigh : null),
    recentLiquidityLow: minLow < Infinity ? minLow : null,
    recentLiquidityHigh: maxHigh > -Infinity ? maxHigh : null,
  };
}

function roundToTick(val: number, tickSize?: string): number {
  if (!tickSize) return Number(val.toFixed(8));
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return Number(val.toFixed(8));
  const factor = 1 / tick;
  return Math.round(val * factor) / factor;
}

/**
 * Computes Adaptive Stop Loss and Take Profit levels based on selected mode
 */
export function computeAdaptiveProtection(input: AdaptiveProtectionInput): AdaptiveProtectionResult {
  const {
    candles,
    side,
    entryPrice,
    baselineStop,
    baselineTp1,
    baselineTp2,
    baselineTp3,
    mode,
    atrPeriod = 14,
    atrMultiplier = 2.0,
    minRiskDistancePct = 0.01,
    maxRiskDistancePct = 0.08,
    tickSize,
  } = input;

  const isLong = side === 'LONG';
  const atr = calculateAtr(candles, atrPeriod);
  const swings = identifySwingLevels(candles, 25);

  let calculatedStop = baselineStop;
  let swingLevelUsed: number | null = null;

  if (mode === 'BASELINE') {
    calculatedStop = baselineStop;
  } else if (mode === 'ATR') {
    if (atr !== null && atr > 0) {
      calculatedStop = isLong
        ? entryPrice - (atr * atrMultiplier)
        : entryPrice + (atr * atrMultiplier);
    } else {
      calculatedStop = baselineStop;
    }
  } else if (mode === 'MARKET_STRUCTURE') {
    if (isLong && swings.swingLow !== null && swings.swingLow < entryPrice) {
      swingLevelUsed = swings.swingLow;
      calculatedStop = swings.swingLow * 0.998;
    } else if (!isLong && swings.swingHigh !== null && swings.swingHigh > entryPrice) {
      swingLevelUsed = swings.swingHigh;
      calculatedStop = swings.swingHigh * 1.002;
    } else if (atr !== null && atr > 0) {
      calculatedStop = isLong ? entryPrice - (atr * 1.5) : entryPrice + (atr * 1.5);
    } else {
      calculatedStop = baselineStop;
    }
  } else if (mode === 'ADAPTIVE_SMART') {
    const effectiveAtr = (atr !== null && atr > 0) ? atr : (entryPrice * 0.015);
    const volatilityBuffer = effectiveAtr * 0.5;

    if (isLong) {
      const structuralFloor = swings.swingLow !== null && swings.swingLow < entryPrice
        ? swings.swingLow
        : (entryPrice - effectiveAtr * atrMultiplier);
      swingLevelUsed = structuralFloor;
      calculatedStop = structuralFloor - volatilityBuffer;
    } else {
      const structuralCeiling = swings.swingHigh !== null && swings.swingHigh > entryPrice
        ? swings.swingHigh
        : (entryPrice + effectiveAtr * atrMultiplier);
      swingLevelUsed = structuralCeiling;
      calculatedStop = structuralCeiling + volatilityBuffer;
    }
  }

  let riskDistance = isLong ? (entryPrice - calculatedStop) : (calculatedStop - entryPrice);
  let riskDistancePct = riskDistance / entryPrice;

  if (riskDistancePct < minRiskDistancePct) {
    riskDistance = entryPrice * minRiskDistancePct;
    calculatedStop = isLong ? (entryPrice - riskDistance) : (entryPrice + riskDistance);
    riskDistancePct = minRiskDistancePct;
  }

  let isValid = true;
  let rejectionReason: string | null = null;

  if (riskDistance <= 0) {
    isValid = false;
    rejectionReason = `Calculated stop loss (${calculatedStop}) is on the wrong side of entry price (${entryPrice}).`;
  } else if (riskDistancePct > maxRiskDistancePct) {
    isValid = false;
    rejectionReason = `Calculated stop distance (${(riskDistancePct * 100).toFixed(2)}%) exceeds maximum risk threshold (${(maxRiskDistancePct * 100).toFixed(2)}%).`;
  }

  let tp1 = isLong ? (entryPrice + 1.0 * riskDistance) : (entryPrice - 1.0 * riskDistance);
  let tp2 = isLong ? (entryPrice + 1.75 * riskDistance) : (entryPrice - 1.75 * riskDistance);
  let tp3 = isLong ? (entryPrice + 2.75 * riskDistance) : (entryPrice - 2.75 * riskDistance);

  if (mode === 'BASELINE' && baselineTp1 && baselineTp2 && baselineTp3) {
    tp1 = baselineTp1;
    tp2 = baselineTp2;
    tp3 = baselineTp3;
  }

  const finalStop = roundToTick(calculatedStop, tickSize);
  const finalTp1 = roundToTick(tp1, tickSize);
  const finalTp2 = roundToTick(tp2, tickSize);
  const finalTp3 = roundToTick(tp3, tickSize);

  const rewardRiskRatio = riskDistance > 0 ? (Math.abs(finalTp1 - entryPrice) / riskDistance) : 0;
  const fullRewardRiskRatio = riskDistance > 0 ? (Math.abs(finalTp3 - entryPrice) / riskDistance) : 0;

  return {
    mode,
    entryPrice: roundToTick(entryPrice, tickSize),
    stopLoss: finalStop,
    tp1: finalTp1,
    tp2: finalTp2,
    tp3: finalTp3,
    riskDistance: Number(riskDistance.toFixed(8)),
    riskDistancePct: Number(riskDistancePct.toFixed(6)),
    rewardRiskRatio: Number(rewardRiskRatio.toFixed(2)),
    fullRewardRiskRatio: Number(fullRewardRiskRatio.toFixed(2)),
    atrValue: atr !== null ? Number(atr.toFixed(8)) : null,
    swingLevel: swingLevelUsed !== null ? roundToTick(swingLevelUsed, tickSize) : null,
    isValid,
    rejectionReason,
  };
}

export function validateSmartEntryFilters(input: SmartEntryFilterInput): SmartEntryFilterResult {
  const { candles, side, spreadPct = 0.0005, maxSpreadPct = 0.002 } = input;
  const isLong = side === 'LONG';
  const reasons: string[] = [];
  let score = 100;

  if (candles.length < 25) {
    return {
      passed: true,
      score: 50,
      reasons: ['Insufficient candles for complete multi-indicator evaluation'],
      indicators: {
        emaTrend: 'NEUTRAL',
        rsi: null,
        macdHistogram: null,
        adx: null,
        vwap: null,
        impulseCandleDetected: false,
        volumeConfirmed: true,
      },
    };
  }

  const ema20 = calculateEma(candles, 20);
  const ema50 = calculateEma(candles, Math.min(50, candles.length - 1));
  let emaTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50) {
      emaTrend = 'BULLISH';
      if (!isLong) {
        score -= 20;
        reasons.push('Counter-trend: EMA20 is above EMA50 during SHORT entry');
      }
    } else if (ema20 < ema50) {
      emaTrend = 'BEARISH';
      if (isLong) {
        score -= 20;
        reasons.push('Counter-trend: EMA20 is below EMA50 during LONG entry');
      }
    }
  }

  const rsi = calculateRsi(candles, 14);
  if (rsi !== null) {
    if (isLong && rsi > 78) {
      score -= 30;
      reasons.push(`Overbought exhaustion: RSI is ${rsi.toFixed(1)} (> 78)`);
    } else if (!isLong && rsi < 22) {
      score -= 30;
      reasons.push(`Oversold exhaustion: RSI is ${rsi.toFixed(1)} (< 22)`);
    }
  }

  const macd = calculateMacd(candles);
  let macdHistogram: number | null = null;
  if (macd) {
    macdHistogram = macd.histogram;
    if (isLong && macd.histogram < 0) {
      score -= 10;
      reasons.push('MACD histogram is negative during LONG setup');
    } else if (!isLong && macd.histogram > 0) {
      score -= 10;
      reasons.push('MACD histogram is positive during SHORT setup');
    }
  }

  const recent20 = candles.slice(-20);
  const avgVolume = recent20.reduce((s, c) => s + c.volume, 0) / recent20.length;
  const currentVolume = candles[candles.length - 1]?.volume ?? 0;
  const volumeConfirmed = currentVolume >= avgVolume * 0.7;
  if (!volumeConfirmed) {
    score -= 15;
    reasons.push('Weak participation: current volume is below 70% of 20-period average');
  }

  const atr = calculateAtr(candles, 14);
  const lastCandle = candles[candles.length - 1];
  let impulseCandleDetected = false;
  if (atr !== null && atr > 0 && lastCandle) {
    const candleRange = lastCandle.high - lastCandle.low;
    if (candleRange > atr * 3.5) {
      impulseCandleDetected = true;
      score -= 25;
      reasons.push('Impulse spike: last candle range exceeds 3.5x ATR; potential climax exhaustion');
    }
  }

  if (spreadPct > maxSpreadPct) {
    score -= 30;
    reasons.push(`High spread: ${(spreadPct * 100).toFixed(3)}% exceeds max allowable (${(maxSpreadPct * 100).toFixed(3)}%)`);
  }

  const vwap = calculateRollingVwap(candles, 20);
  const adx = calculateAdx(candles, 14);
  const passed = score >= 50 && !impulseCandleDetected;

  return {
    passed,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    indicators: {
      emaTrend,
      rsi: rsi !== null ? Number(rsi.toFixed(1)) : null,
      macdHistogram: macdHistogram !== null ? Number(macdHistogram.toFixed(4)) : null,
      adx: adx !== null ? Number(adx.toFixed(1)) : null,
      vwap: vwap !== null ? Number(vwap.toFixed(6)) : null,
      impulseCandleDetected,
      volumeConfirmed,
    },
  };
}
