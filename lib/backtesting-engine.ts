export type BacktestCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type BacktestSignal = {
  id: string;
  strategy: 'STANDARD' | 'HIGH_RISK';
  side: 'LONG' | 'SHORT';
  generatedAt: number;
  entryExpiresAt: number;
  expiresAt: number;
  candleIntervalMs: number;
  entryPrice: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number | null;
};

export type BacktestEvent = {
  type: 'ENTRY_REACHED' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'STOP_LOSS_HIT';
  observedAt: number;
  price: number;
};

export type BacktestResult = {
  signalId: string;
  strategy: BacktestSignal['strategy'];
  status: 'OPEN' | 'WAITING_ENTRY' | 'TP2_HIT' | 'TP3_HIT' | 'STOP_LOSS_HIT' |
    'MISSED' | 'ENTRY_INVALIDATED' | 'EXPIRED' | 'AMBIGUOUS' | 'DATA_INCOMPLETE';
  events: BacktestEvent[];
  simulatedEntry: number | null;
  simulatedExit: number | null;
  grossReturnPercent: number | null;
  grossRiskMultiple: number | null;
  reason: string;
};

const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validPrice = (value: number) => Number.isFinite(value) && value > 0;

/**
 * An explicitly supplied TP3 closes the research position.
 * High-Risk strategy parity uses TP2 as the final target.
 */
export function evaluateHistoricalSignal(
  signal: BacktestSignal, candles: readonly BacktestCandle[], asOf: number,
): BacktestResult {
  const { generatedAt, entryExpiresAt, expiresAt, candleIntervalMs: interval } = signal;
  if (!signal.id || !['STANDARD', 'HIGH_RISK'].includes(signal.strategy) ||
      !['LONG', 'SHORT'].includes(signal.side) ||
      ![generatedAt, entryExpiresAt, expiresAt, asOf, interval].every(validTimestamp) ||
      interval < 2 || generatedAt >= entryExpiresAt || entryExpiresAt > expiresAt || asOf < generatedAt) {
    throw new RangeError('Invalid historical signal scope or time window.');
  }
  const direction = signal.side === 'LONG' ? 1 : -1;
  if (signal.tp3 === null && signal.strategy !== 'HIGH_RISK') throw new RangeError('Standard requires TP3.');
  const targetPrices = signal.tp3 === null ? [signal.tp1, signal.tp2] : [signal.tp1, signal.tp2, signal.tp3];
  const directionalLevels = [signal.stop, signal.entryPrice, ...targetPrices];
  if (![...directionalLevels, signal.entryZoneLow, signal.entryZoneHigh].every(validPrice) ||
      signal.entryZoneLow > signal.entryPrice || signal.entryPrice > signal.entryZoneHigh ||
      directionalLevels.some((level, index) => index > 0 && direction * (level - directionalLevels[index - 1]!) <= 0) ||
      (direction === 1
        ? signal.stop >= signal.entryZoneLow || signal.tp1 <= signal.entryZoneHigh
        : signal.stop <= signal.entryZoneHigh || signal.tp1 >= signal.entryZoneLow)) {
    throw new RangeError('Invalid historical entry, stop or TP1/TP2/TP3 ordering.');
  }

  const events: BacktestEvent[] = [];
  let simulatedEntry: number | null = null;
  let reached = 0;
  const targetEvents = ['TP1_HIT', 'TP2_HIT', 'TP3_HIT'] as const;
  const finalTarget = signal.tp3 === null ? 'TP2_HIT' : 'TP3_HIT';
  function finish(status: BacktestResult['status'], reason: string, simulatedExit: number | null = null): BacktestResult {
    const difference = simulatedEntry !== null && simulatedExit !== null
      ? direction * (simulatedExit - simulatedEntry) : null;
    const returnPercent = difference === null || simulatedEntry === null ? NaN : 100 * (difference / simulatedEntry);
    const riskMultiple = difference === null || simulatedEntry === null ? NaN : difference / Math.abs(simulatedEntry - signal.stop);
    const grossReturnPercent = Number.isFinite(returnPercent) ? returnPercent : null;
    const grossRiskMultiple = Number.isFinite(riskMultiple) ? riskMultiple : null;
    return { signalId: signal.id, strategy: signal.strategy, status, events,
      simulatedEntry, simulatedExit, grossReturnPercent, grossRiskMultiple, reason };
  }

  // Use only fully observable candles and never examine the pre-signal portion of a bar.
  let expectedOpen = Math.ceil(generatedAt / interval) * interval;
  const stopTouched = (candle: BacktestCandle) => direction === 1 ? candle.low <= signal.stop : candle.high >= signal.stop;
  const targetTouched = (candle: BacktestCandle, target: number) => direction === 1 ? candle.high >= target : candle.low <= target;
  const insideEntry = (price: number) => price >= signal.entryZoneLow && price <= signal.entryZoneHigh;
  for (const candle of candles) {
    if (!validTimestamp(candle.openTime) || !validTimestamp(candle.closeTime)) {
      return finish('DATA_INCOMPLETE', 'A candle timestamp is invalid.');
    }
    if (candle.openTime < generatedAt || candle.closeTime >= asOf || candle.openTime >= expiresAt) continue;
    if (candle.openTime !== expectedOpen || candle.closeTime !== candle.openTime + interval - 1 ||
        ![candle.open, candle.high, candle.low, candle.close].every(validPrice) ||
        candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)) {
      return finish('DATA_INCOMPLETE', 'Historical candles are incomplete, out of order or invalid.');
    }
    expectedOpen += interval;
    const entryTouched = candle.high >= signal.entryZoneLow && candle.low <= signal.entryZoneHigh;
    const stillWaiting = simulatedEntry === null;
    const deadline = stillWaiting ? entryExpiresAt : expiresAt;
    if (candle.openTime >= deadline) break;
    const remaining = targetPrices.slice(reached);
    const stop = stopTouched(candle);
    const nextTarget = remaining.some(target => targetTouched(candle, target));
    const wouldTrigger = stillWaiting ? entryTouched : stop || nextTarget;
    if (candle.closeTime >= deadline) {
      if (wouldTrigger) return finish('AMBIGUOUS', 'An OHLC candle spans the deadline and contains a possible trigger.');
      break;
    }
    if (stillWaiting) {
      if (!entryTouched) {
        const invalidated = direction === 1 ? candle.high < signal.entryZoneLow : candle.low > signal.entryZoneHigh;
        return invalidated ? finish('ENTRY_INVALIDATED', 'Price moved beyond the entry zone toward the stop.') :
          finish('MISSED', 'Price moved beyond the entry zone toward the targets.');
      }
      if (!insideEntry(candle.open) && (stop || nextTarget)) {
        return finish('AMBIGUOUS', 'An OHLC candle contains both entry and an exit or target with unknown sequence.');
      }
      simulatedEntry = Math.min(signal.entryZoneHigh, Math.max(signal.entryZoneLow, candle.open));
      events.push({ type: 'ENTRY_REACHED', price: simulatedEntry, observedAt: candle.closeTime });
    }
    const stopGap = direction * (candle.open - signal.stop) <= 0;
    while (reached < targetPrices.length && direction * (candle.open - targetPrices[reached]!) >= 0) {
      const price = targetPrices[reached]!;
      const type = targetEvents[reached]!;
      events.push({ type, price, observedAt: candle.openTime });
      reached++;
      if (type === finalTarget) return finish(type, 'The final target closed the simulated position after an opening gap.', price);
    }
    const unrecordedTarget = targetPrices.slice(reached).some(target => targetTouched(candle, target));
    if (stop && unrecordedTarget && !stopGap) {
      return finish('AMBIGUOUS', 'Both stop and an unrecorded target were touched in one OHLC candle.');
    }
    if (stop) {
      const exit = stopGap ? candle.open : signal.stop;
      events.push({ type: 'STOP_LOSS_HIT', price: exit, observedAt: candle.closeTime });
      return finish('STOP_LOSS_HIT', 'The simulated position closed at the stop or a worse opening gap.', exit);
    }
    while (reached < targetPrices.length && targetTouched(candle, targetPrices[reached]!)) {
      const target = targetPrices[reached]!;
      const type = targetEvents[reached]!;
      events.push({ type, price: target, observedAt: candle.closeTime });
      reached++;
      if (type === finalTarget) return finish(type, 'The final target closed the simulated position.', target);
    }
  }

  const deadline = simulatedEntry === null ? entryExpiresAt : expiresAt;
  const observedThrough = Math.min(asOf, deadline);
  if (expectedOpen + interval <= observedThrough) {
    return finish('DATA_INCOMPLETE', 'Closed candles are missing before the evaluation boundary.');
  }
  if (asOf >= deadline && expectedOpen < deadline) {
    return finish('DATA_INCOMPLETE', 'The candle covering the deadline is unavailable.');
  }
  if (asOf >= deadline) {
    return simulatedEntry === null ? finish('MISSED', 'The entry window expired without a verified entry.') :
      finish('EXPIRED', 'The position remained unresolved when the signal expired.');
  }
  return simulatedEntry === null ? finish('WAITING_ENTRY', 'The entry window remains open.') :
    finish('OPEN', 'The simulated position is open. Milestones do not realize returns.');
}
