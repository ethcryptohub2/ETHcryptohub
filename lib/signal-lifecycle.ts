import { pool, query } from './db';
import type { FuturesMarketSnapshot } from '../smartexit/apps/api/src/services/binance-futures-markets';

type LifecycleStatus =
  | 'ACTIVE'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'COMPLETED'
  | 'STOP_LOSS_HIT'
  | 'EXPIRED'
  | 'ENTRY_INVALIDATED'
  | 'MISSED'
  | 'AMBIGUOUS';

type EntryStatus = 'OPEN' | 'ENTERED' | 'MISSED' | 'EXPIRED' | 'INVALIDATED';

type TrackedSignal = {
  id: string;
  signal_key: string;
  legacy_scalping_signal_id: string | null;
  scanner_type: 'STANDARD' | 'HIGH_RISK';
  symbol: string;
  timeframe: '1m' | '3m' | '5m' | '15m' | '1h' | '4h';
  side: 'LONG' | 'SHORT';
  status: LifecycleStatus;
  entry_status: EntryStatus;
  generated_at: string;
  lifecycle_checked_at: string;
  entry_expires_at: string;
  expires_at: string;
  entry_price: string;
  entry_zone_low: string;
  entry_zone_high: string;
  initial_stop: string;
  tp1: string;
  tp2: string;
  tp3: string | null;
  latest_price: string;
  setup_score: number;
};

type TriggerCandle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function parseCandle(row: unknown, symbol: string, timeframe: string): TriggerCandle {
  if (!Array.isArray(row) || row.length < 7) throw new Error(`Binance returned an invalid lifecycle candle for ${symbol} ${timeframe}.`);
  const [openTime, open, high, low, close, , closeTime] = row.map(Number);
  if (
    ![openTime, open, high, low, close, closeTime].every(Number.isFinite) ||
    [open, high, low, close].some((value) => value <= 0) ||
    high < low
  ) throw new Error(`Binance returned invalid lifecycle candle values for ${symbol} ${timeframe}.`);
  return { openTime, closeTime, open, high, low, close };
}

async function fetchLifecycleCandles(
  signal: TrackedSignal,
  now: number,
  request: typeof fetch,
): Promise<TriggerCandle[]> {
  const startTime = Math.max(Date.parse(signal.generated_at), Date.parse(signal.lifecycle_checked_at));
  const endTime = Math.min(now, Date.parse(signal.expires_at));
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return [];
  const url = new URL('https://fapi.binance.com/fapi/v1/klines');
  url.searchParams.set('symbol', signal.symbol);
  url.searchParams.set('interval', signal.timeframe);
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('endTime', String(endTime));
  url.searchParams.set('limit', '1000');
  const response = await request(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance lifecycle candle request failed (${response.status}) for ${signal.symbol} ${signal.timeframe}.`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error(`Binance returned invalid lifecycle candles for ${signal.symbol} ${signal.timeframe}.`);
  return payload
    .map((row) => parseCandle(row, signal.symbol, signal.timeframe))
    .filter((candle) => candle.closeTime < now && candle.closeTime <= Date.parse(signal.expires_at) && candle.closeTime >= startTime)
    .sort((left, right) => left.openTime - right.openTime);
}

function crossed(side: TrackedSignal['side'], candle: TriggerCandle, level: number) {
  return side === 'LONG' ? candle.high >= level : candle.low <= level;
}

function crossedStop(side: TrackedSignal['side'], candle: TriggerCandle, level: number) {
  return side === 'LONG' ? candle.low <= level : candle.high >= level;
}

function crossedEntry(signal: TrackedSignal, candle: TriggerCandle) {
  const low = Number(signal.entry_zone_low);
  const high = Number(signal.entry_zone_high);
  return candle.high >= low && candle.low <= high;
}

async function persistCandleTransitions(
  signal: TrackedSignal,
  candles: TriggerCandle[],
  latestPrice: number | null,
  now: number,
) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{
      status: LifecycleStatus;
      entry_status: EntryStatus;
      entry_price: string;
      setup_score: number;
    }>(
      `SELECT status, entry_status, entry_price::TEXT, setup_score
         FROM public.market_signals WHERE id = $1 FOR UPDATE`,
      [signal.id],
    );
    if (!locked.rowCount || !['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(locked.rows[0]!.status)) {
      await client.query('COMMIT');
      return;
    }

    let status = locked.rows[0]!.status;
    let entryStatus = locked.rows[0]!.entry_status;
    let targetRank = status === 'TP1_HIT' ? 1 : status === 'TP2_HIT' ? 2 : 0;
    let terminal = ['TP3_HIT', 'COMPLETED', 'STOP_LOSS_HIT', 'EXPIRED', 'ENTRY_INVALIDATED', 'MISSED', 'AMBIGUOUS'].includes(status);

    const record = async (
      eventType: string,
      nextStatus: LifecycleStatus,
      price: number | null,
      eventAt: number,
      metadata: Record<string, unknown>,
      nextEntryStatus = entryStatus,
    ) => {
      const eventKey = `${signal.signal_key}:${eventType}`;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.signal_events (
           signal_id, idempotency_key, event_type, payload, event_price,
           event_timestamp, metadata
         ) VALUES ($1, $2, $3, $4::JSONB, $5, to_timestamp($6 / 1000.0), $7::JSONB)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::TEXT`,
        [
          signal.id,
          eventKey,
          eventType,
          JSON.stringify({ symbol: signal.symbol, timeframe: signal.timeframe, side: signal.side, status: nextStatus }),
          price,
          eventAt,
          JSON.stringify({ ...metadata, priceSource: 'BINANCE_USDM_KLINES_HIGH_LOW' }),
        ],
      );
      if (!inserted.rowCount) return false;
      status = nextStatus;
      entryStatus = nextEntryStatus;
      targetRank = status === 'TP1_HIT' ? 1 : status === 'TP2_HIT' ? 2 : status === 'TP3_HIT' ? 3 : targetRank;
      terminal = ['TP3_HIT', 'COMPLETED', 'STOP_LOSS_HIT', 'EXPIRED', 'ENTRY_INVALIDATED', 'MISSED', 'AMBIGUOUS'].includes(status);
      if (eventType === 'TP1_HIT') targetRank = 1;
      if (eventType === 'TP2_HIT') targetRank = 2;
      if (eventType === 'TP3_HIT') targetRank = 3;
      await client.query(
        `UPDATE public.market_signals
            SET status = $2, entry_status = $3, latest_price = COALESCE($4, latest_price),
                updated_at = NOW(), closed_at = CASE WHEN $5 THEN to_timestamp($6 / 1000.0) ELSE closed_at END,
                lifecycle_checked_at = to_timestamp($6 / 1000.0)
          WHERE id = $1`,
        [signal.id, status, entryStatus, latestPrice, terminal, eventAt],
      );
      if (signal.legacy_scalping_signal_id) {
        const legacyStatus = status === 'MISSED' ? 'MISSED'
          : status === 'EXPIRED' ? 'EXPIRED'
            : status === 'COMPLETED' ? 'COMPLETED'
              : ['ENTRY_INVALIDATED', 'STOP_LOSS_HIT', 'AMBIGUOUS'].includes(status) ? 'INVALIDATED'
                : 'ACTIVE';
        await client.query(
          `UPDATE public.high_risk_scalping_signals
              SET lifecycle_status = $2, last_price = COALESCE($3, last_price)
            WHERE id = $1`,
          [signal.legacy_scalping_signal_id, legacyStatus, latestPrice],
        );
      }
      if (status === 'TP3_HIT' || status === 'COMPLETED' || status === 'STOP_LOSS_HIT') {
        const entry = Number(locked.rows[0]!.entry_price);
        const exit = price ?? Number(signal.latest_price);
        const signedDifference = signal.side === 'LONG' ? exit - entry : entry - exit;
        const pnlPercentage = signedDifference / entry * 100;
        const resultType = status === 'STOP_LOSS_HIT'
          ? 'STOP_LOSS_SIMULATED'
          : status === 'TP3_HIT' ? 'TP3_SIMULATED' : 'TP2_SIMULATED';
        const duration = Math.max(0, Math.floor((eventAt - Date.parse(signal.generated_at)) / 1000));
        await client.query(
          `UPDATE public.market_signals SET simulated_pnl = $2 WHERE id = $1`,
          [signal.id, signedDifference],
        );
        await client.query(
          `INSERT INTO public.signal_performance (
             signal_id, entry_price, exit_price, simulated_pnl, pnl_percentage,
             result_type, holding_duration_seconds, calculation_method, calculated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'UNLEVERAGED_ONE_UNIT_TRIGGER_LEVEL_NO_FEES', NOW())
           ON CONFLICT (signal_id) DO NOTHING`,
          [signal.id, entry, exit, signedDifference, pnlPercentage, resultType, duration],
        );
      }
      return true;
    };

    for (const candle of candles) {
      if (terminal) break;
      if (entryStatus === 'OPEN') {
        const entryExpiry = Date.parse(signal.entry_expires_at);
        if (candle.openTime < entryExpiry && candle.closeTime > entryExpiry) {
          if (crossedEntry(signal, candle)) {
            await record('AMBIGUOUS_PRICE_PATH', 'AMBIGUOUS', null, entryExpiry, {
              candleOpenAt: new Date(candle.openTime).toISOString(),
              open: candle.open, high: candle.high, low: candle.low, close: candle.close,
              reason: 'The entry window expired during a candle that crossed the entry zone.',
            });
          }
          break;
        }
        if (candle.openTime >= entryExpiry) break;
        const entryLow = Number(signal.entry_zone_low);
        const entryHigh = Number(signal.entry_zone_high);
        if (!crossedEntry(signal, candle)) {
          const invalidated = signal.side === 'LONG' ? candle.high < entryLow : candle.low > entryHigh;
          const gapMissed = signal.side === 'LONG' ? candle.low > entryHigh : candle.high < entryLow;
          if (invalidated) {
            await record('SIGNAL_INVALIDATED', 'ENTRY_INVALIDATED', null, candle.closeTime, {
              candleOpenAt: new Date(candle.openTime).toISOString(),
              open: candle.open, high: candle.high, low: candle.low, close: candle.close,
              entryZoneLow: entryLow, entryZoneHigh: entryHigh,
            }, 'INVALIDATED');
            break;
          }
          if (gapMissed) {
            await record('ENTRY_MISSED', 'MISSED', null, candle.closeTime, {
              candleOpenAt: new Date(candle.openTime).toISOString(),
              open: candle.open, high: candle.high, low: candle.low, close: candle.close,
              entryZoneLow: entryLow, entryZoneHigh: entryHigh,
              reason: 'Price gapped beyond the reference entry zone without touching it.',
            }, 'MISSED');
            break;
          }
          continue;
        }
        await record('ENTRY_REACHED', status, null, candle.closeTime, {
          candleOpenAt: new Date(candle.openTime).toISOString(),
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          entryZoneLow: entryLow, entryZoneHigh: entryHigh,
          entryMeaning: 'market price entered the reference zone; not a user trade',
        }, 'ENTERED');
      }
      const stopPrice = Number(signal.initial_stop);
      const targets = [signal.tp1, signal.tp2, signal.tp3]
        .map((value, index) => ({ price: value === null ? null : Number(value), rank: index + 1 }))
        .filter((target): target is { price: number; rank: number } =>
          target.price !== null && Number.isFinite(target.price) && target.rank > targetRank,
        );
      const reachedTargets = targets.filter((target) => crossed(signal.side, candle, target.price));
      const stopReached = crossedStop(signal.side, candle, stopPrice);
      const eventAt = Math.min(candle.closeTime, now);
      const candleData = { candleOpenAt: new Date(candle.openTime).toISOString(), open: candle.open, high: candle.high, low: candle.low, close: candle.close };
      if (stopReached && reachedTargets.length) {
        await record('AMBIGUOUS_PRICE_PATH', 'AMBIGUOUS', null, eventAt, {
          ...candleData,
          stopLevel: stopPrice,
          targetLevels: reachedTargets.map((target) => target.price),
          resolution: 'Both stop and target were inside one candle; OHLC data cannot establish order.',
        }, entryStatus);
        break;
      }
      if (stopReached) {
        await record('STOP_LOSS_HIT', 'STOP_LOSS_HIT', stopPrice, eventAt, { ...candleData, triggerLevel: stopPrice });
        break;
      }
      for (const target of reachedTargets) {
        if (terminal) break;
        const eventType = `TP${target.rank}_HIT`;
        const targetStatus = eventType as LifecycleStatus;
        const completedHighRiskTarget = signal.scanner_type === 'HIGH_RISK' && target.rank === 2;
        await record(
          eventType,
          completedHighRiskTarget ? 'COMPLETED' : targetStatus,
          target.price,
          eventAt,
          { ...candleData, triggerLevel: target.price },
        );
      }
      if (terminal) break;
    }

    if (!terminal && Date.parse(signal.entry_expires_at) <= now && entryStatus === 'OPEN') {
      await record('ENTRY_MISSED', 'MISSED', latestPrice, Date.parse(signal.entry_expires_at), {
        reason: 'Entry window expired before the market reached the reference entry zone.',
      }, 'MISSED');
    }
    if (!terminal && Date.parse(signal.expires_at) <= now) {
      const entryExpired = entryStatus === 'OPEN' ? 'EXPIRED' : entryStatus;
      await record('SIGNAL_EXPIRED', 'EXPIRED', latestPrice, Date.parse(signal.expires_at), {
        reason: 'Signal validity elapsed without a terminal target or stop outcome.',
      }, entryExpired);
    }
    await client.query(
      `UPDATE public.market_signals
          SET latest_price = COALESCE($2, latest_price),
              lifecycle_checked_at = to_timestamp($3 / 1000.0),
              updated_at = NOW()
        WHERE id = $1 AND status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT')`,
      [signal.id, latestPrice, now],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Signal lifecycle rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function processPersistedSignalLifecycle(
  snapshot: FuturesMarketSnapshot,
  now = Date.now(),
  request: typeof fetch = globalThis.fetch,
) {
  const result = await query<TrackedSignal>(
    `SELECT id::TEXT AS id, signal_key, legacy_scalping_signal_id::TEXT, scanner_type, symbol, timeframe, side, status,
            entry_status, generated_at, lifecycle_checked_at, entry_expires_at, expires_at,
            entry_price::TEXT, entry_zone_low::TEXT, entry_zone_high::TEXT,
            initial_stop::TEXT, tp1::TEXT, tp2::TEXT, tp3::TEXT,
            latest_price::TEXT, setup_score
       FROM public.market_signals
      WHERE status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT')
      ORDER BY expires_at ASC LIMIT 1000`,
  );
  const prices = new Map(snapshot.symbols.map((market) => [market.symbol, market.lastPrice]));
  const candleCache = new Map<string, TriggerCandle[]>();
  for (const signal of result.rows) {
    const key = `${signal.symbol}:${signal.timeframe}:${signal.generated_at}:${signal.lifecycle_checked_at}`;
    let candles = candleCache.get(key);
    if (!candles) {
      candles = await fetchLifecycleCandles(signal, now, request);
      candleCache.set(key, candles);
    }
    await persistCandleTransitions(signal, candles, prices.get(signal.symbol) ?? null, now);
  }
}
