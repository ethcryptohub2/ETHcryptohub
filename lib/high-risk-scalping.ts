import { createHash } from 'node:crypto';
import { sendNotification, setVapidDetails } from 'web-push';
import { pool, query, recordSignalPersistenceFailure, retryDatabaseWrite } from './db';
import {
  SCALPING_TIMEFRAMES,
  type HighRiskScalpingSettings,
  type ScalpingSetup,
  type ScalpingSide,
  type ScalpingTimeframe,
  type StoredScalpingSignal,
} from './high-risk-scalping-types';
import { isSupportedPushEndpoint } from './notifications';
import { processPersistedSignalLifecycle } from './signal-lifecycle';
import { getEnabledScannerSymbols } from './scanner-coins';
import { BinanceFuturesMarketsService } from '../smartexit/apps/api/src/services/binance-futures-markets';
import {
  calculateAdx,
  calculateAtr,
  calculateEma,
  calculateMacd,
  calculateRsi,
  calculateRollingVwap,
  calculateSupertrend,
  type MarketCandle,
} from '../smartexit/apps/api/src/services/market-scanner';

export { SCALPING_TIMEFRAMES } from './high-risk-scalping-types';
export type {
  HighRiskScalpingSettings,
  ScalpingSetup,
  ScalpingSide,
  ScalpingTimeframe,
  StoredScalpingSignal,
} from './high-risk-scalping-types';

const DEFAULT_ENTRY_VALIDITY: Record<ScalpingTimeframe, number> = { '1m': 5, '3m': 8, '5m': 12, '15m': 20 };
const DEFAULT_SIGNAL_VALIDITY: Record<ScalpingTimeframe, number> = { '1m': 15, '3m': 30, '5m': 60, '15m': 120 };
const markets = new BinanceFuturesMarketsService();
const DEFAULT_BATCH_SIZE = 10;

type SettingsRow = {
  enabled: boolean;
  enabled_timeframes: unknown;
  minimum_setup_score: number;
  minimum_quote_volume: string | number;
  minimum_relative_volume: string | number;
  entry_validity_minutes: Record<string, unknown>;
  signal_validity_minutes: Record<string, unknown>;
};

function boundedMinutes(source: Record<string, unknown> | null | undefined, defaults: Record<ScalpingTimeframe, number>) {
  const result = { ...defaults };
  for (const timeframe of SCALPING_TIMEFRAMES) {
    const value = Number(source?.[timeframe]);
    if (Number.isInteger(value) && value >= 1 && value <= 240) result[timeframe] = value;
  }
  return result;
}

export function defaultHighRiskScalpingSettings(): HighRiskScalpingSettings {
  return {
    enabled: false,
    enabledTimeframes: [...SCALPING_TIMEFRAMES],
    minimumSetupScore: 75,
    minimumQuoteVolume: 5_000_000,
    minimumRelativeVolume: 1.5,
    entryValidityMinutes: { ...DEFAULT_ENTRY_VALIDITY },
    signalValidityMinutes: { ...DEFAULT_SIGNAL_VALIDITY },
  };
}

export async function getHighRiskScalpingSettings(): Promise<HighRiskScalpingSettings> {
  const result = await query<SettingsRow>(
    `SELECT enabled, enabled_timeframes, minimum_setup_score, minimum_quote_volume,
            minimum_relative_volume, entry_validity_minutes, signal_validity_minutes
       FROM public.high_risk_scalping_settings WHERE singleton = TRUE`,
  );
  const row = result.rows[0];
  if (!row) return defaultHighRiskScalpingSettings();
  const enabledTimeframes = Array.isArray(row.enabled_timeframes)
    ? row.enabled_timeframes.filter((value): value is ScalpingTimeframe =>
        typeof value === 'string' && SCALPING_TIMEFRAMES.includes(value as ScalpingTimeframe))
    : [];
  return {
    enabled: row.enabled,
    enabledTimeframes,
    minimumSetupScore: row.minimum_setup_score,
    minimumQuoteVolume: Number(row.minimum_quote_volume),
    minimumRelativeVolume: Number(row.minimum_relative_volume),
    entryValidityMinutes: boundedMinutes(row.entry_validity_minutes, DEFAULT_ENTRY_VALIDITY),
    signalValidityMinutes: boundedMinutes(row.signal_validity_minutes, DEFAULT_SIGNAL_VALIDITY),
  };
}

export async function updateHighRiskScalpingSettings(settings: HighRiskScalpingSettings) {
  await query(
    `UPDATE public.high_risk_scalping_settings
        SET enabled = $1, enabled_timeframes = $2::JSONB, minimum_setup_score = $3,
            minimum_quote_volume = $4, minimum_relative_volume = $5,
            entry_validity_minutes = $6::JSONB, signal_validity_minutes = $7::JSONB,
            updated_at = NOW()
      WHERE singleton = TRUE`,
    [
      settings.enabled,
      JSON.stringify(settings.enabledTimeframes),
      settings.minimumSetupScore,
      settings.minimumQuoteVolume,
      settings.minimumRelativeVolume,
      JSON.stringify(settings.entryValidityMinutes),
      JSON.stringify(settings.signalValidityMinutes),
    ],
  );
}

function hashKey(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function scoreSetup(input: {
  side: ScalpingSide;
  candles: MarketCandle[];
  price: number;
  btcDirection: ScalpingSetup['context']['btcDirection'];
  minimumRelativeVolume: number;
}) {
  const candles = input.candles;
  if (candles.length < 60) return null;
  const last = candles.at(-1)!;
  const previous = candles.slice(-13, -1);
  const breakoutLevel = input.side === 'LONG'
    ? Math.max(...previous.map((candle) => candle.high))
    : Math.min(...previous.map((candle) => candle.low));
  const breakout = input.side === 'LONG' ? last.close > breakoutLevel : last.close < breakoutLevel;
  const candleConfirmed = input.side === 'LONG' ? last.close > (last.high + last.low) / 2 : last.close < (last.high + last.low) / 2;
  const atr = calculateAtr(candles, 7);
  const ema9 = calculateEma(candles, 9);
  const ema20 = calculateEma(candles, 20);
  const rsi = calculateRsi(candles, 14);
  const macd = calculateMacd(candles);
  const vwap = calculateRollingVwap(candles, 20);
  const adx = calculateAdx(candles, 14);
  const supertrend = calculateSupertrend(candles, 7, 2);
  const priorVolumes = candles.slice(-21, -1).map((candle) => candle.volume);
  const averageVolume = priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length;
  const relativeVolume = averageVolume > 0 ? last.volume / averageVolume : null;
  if (
    !atr || !ema9 || !ema20 || rsi === null || !macd || !vwap || adx === null ||
    !supertrend || relativeVolume === null || !Number.isFinite(relativeVolume)
  ) return null;

  const emaAligned = input.side === 'LONG' ? ema9 > ema20 : ema9 < ema20;
  const momentumAligned = input.side === 'LONG' ? rsi >= 52 && rsi <= 75 && macd.histogram > 0 : rsi <= 48 && rsi >= 25 && macd.histogram < 0;
  const valueAligned = input.side === 'LONG' ? input.price > vwap : input.price < vwap;
  const trendAligned = supertrend.direction === (input.side === 'LONG' ? 'BULLISH' : 'BEARISH');
  const btcAligned = input.btcDirection === 'NEUTRAL' || input.btcDirection === (input.side === 'LONG' ? 'BULLISH' : 'BEARISH');
  const volumeAligned = relativeVolume >= input.minimumRelativeVolume;
  const adxAligned = adx >= 18;
  const factors = [breakout, candleConfirmed, emaAligned, momentumAligned, valueAligned, trendAligned, btcAligned, volumeAligned, adxAligned];
  const score = Math.round(factors.filter(Boolean).length / factors.length * 100);
  if (!breakout || !candleConfirmed || !emaAligned || !momentumAligned || !valueAligned || !trendAligned || !volumeAligned) return null;
  const risk = Math.max(atr * 1.2, input.price * 0.001);
  const stop = input.side === 'LONG' ? input.price - risk : input.price + risk;
  const tp1 = input.side === 'LONG' ? input.price + risk : input.price - risk;
  const tp2 = input.side === 'LONG' ? input.price + risk * 1.5 : input.price - risk * 1.5;
  return {
    score,
    atr,
    ema9,
    ema20,
    rsi,
    relativeVolume,
    vwap,
    adx,
    supertrend: supertrend.direction,
    breakoutLevel,
    stop,
    tp1,
    tp2,
    btcAligned,
    breakout,
  };
}

export function analyzeHighRiskScalpingSetup(input: {
  symbol: string;
  timeframe: ScalpingTimeframe;
  candles: MarketCandle[];
  price: number;
  btcDirection: ScalpingSetup['context']['btcDirection'];
  settings: HighRiskScalpingSettings;
  now?: number;
}): ScalpingSetup | null {
  if (!Number.isFinite(input.price) || input.price <= 0 || !input.candles.length) return null;
  const now = input.now ?? Date.now();
  const candles = input.candles.filter((candle) => candle.closeTime < now);
  if (candles.length < 60) return null;
  const latest = candles.at(-1)!;
  const ageLimit = (Number(input.timeframe.slice(0, -1)) * 60_000) * 3 + 5 * 60_000;
  if (now - latest.closeTime > ageLimit) return null;
  const directional: ScalpingSide[] = input.btcDirection === 'NEUTRAL'
    ? ['LONG', 'SHORT']
    : [input.btcDirection === 'BULLISH' ? 'LONG' : 'SHORT'];
  for (const side of directional) {
    const analysis = scoreSetup({
      side,
      candles,
      price: input.price,
      btcDirection: input.btcDirection,
      minimumRelativeVolume: input.settings.minimumRelativeVolume,
    });
    if (!analysis || analysis.score < input.settings.minimumSetupScore) continue;
    const entryDelta = analysis.atr * 0.1;
    return {
      signalKey: hashKey(`${input.symbol}:${input.timeframe}:${side}:${latest.openTime}:${analysis.breakoutLevel}`),
      symbol: input.symbol,
      timeframe: input.timeframe,
      side,
      score: analysis.score,
      entryPrice: input.price,
      entryZoneLow: Math.max(input.price * 0.000001, input.price - entryDelta),
      entryZoneHigh: input.price + entryDelta,
      stop: analysis.stop,
      tp1: analysis.tp1,
      tp2: analysis.tp2,
      lastPrice: input.price,
      candleOpenAt: new Date(latest.openTime).toISOString(),
      context: {
        rsi: analysis.rsi,
        relativeVolume: analysis.relativeVolume,
        ema9: analysis.ema9,
        ema20: analysis.ema20,
        vwap: analysis.vwap,
        adx: analysis.adx,
        supertrend: analysis.supertrend,
        btcDirection: input.btcDirection,
        breakoutLevel: analysis.breakoutLevel,
        warning: 'HIGH RISK · informational only; no order is placed.',
      },
    };
  }
  return null;
}

async function fetchCandles(symbol: string, timeframe: ScalpingTimeframe, request: typeof fetch): Promise<MarketCandle[]> {
  const url = new URL('https://fapi.binance.com/fapi/v1/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', timeframe);
  url.searchParams.set('limit', '100');
  const response = await request(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance candle request failed (${response.status}) for ${symbol} ${timeframe}.`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error(`Binance returned invalid candle data for ${symbol} ${timeframe}.`);
  return body.map((row): MarketCandle => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`Binance returned invalid candle data for ${symbol} ${timeframe}.`);
    const [openTime, open, high, low, close, volume, closeTime] = row.map(Number);
    if (![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite) || [open, high, low, close].some((value) => value <= 0) || volume < 0) {
      throw new Error(`Binance returned invalid candle values for ${symbol} ${timeframe}.`);
    }
    return { openTime, high, low, close, volume, closeTime };
  });
}

async function notifyNewSignal(signalId: string, setup: ScalpingSetup) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return;
  setVapidDetails(subject, publicKey, privateKey);
  const result = await query<{ user_id: number; endpoint: string; p256dh: string; auth: string }>(
    `SELECT p.user_id, p.endpoint, p.p256dh, p.auth
       FROM public.high_risk_scalping_preferences hp
       JOIN public.push_subscriptions p ON p.user_id = hp.user_id
       JOIN public.user_notification_preferences up ON up.user_id = hp.user_id
      WHERE hp.push_enabled = TRUE AND up.push_enabled = TRUE`,
  );
  await Promise.all(result.rows.map(async (subscription) => {
    const inserted = await query<{ id: string }>(
      `INSERT INTO public.high_risk_scalping_notifications (user_id, signal_id)
       VALUES ($1, $2) ON CONFLICT (user_id, signal_id) DO NOTHING RETURNING id::text`,
      [subscription.user_id, signalId],
    );
    if (!inserted.rowCount) return;
    if (!isSupportedPushEndpoint(subscription.endpoint)) {
      await query('DELETE FROM public.push_subscriptions WHERE user_id = $1 AND endpoint = $2', [subscription.user_id, subscription.endpoint]);
      return;
    }
    const payload = JSON.stringify({
      title: `HIGH RISK · ${setup.side} ${setup.symbol}`,
      body: `${setup.timeframe} setup · score ${setup.score}/100. Informational only.`,
      url: '/scanner?tab=scalping',
      eventId: inserted.rows[0]!.id,
      data: { side: setup.side, entry: setup.entryPrice, stop: setup.stop, targets: [setup.tp1, setup.tp2] },
    });
    try {
      await sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 300 });
      await query('UPDATE public.push_subscriptions SET last_used_at = NOW() WHERE user_id = $1 AND endpoint = $2', [subscription.user_id, subscription.endpoint]);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 0;
      if (status === 404 || status === 410) {
        await query('DELETE FROM public.push_subscriptions WHERE user_id = $1 AND endpoint = $2', [subscription.user_id, subscription.endpoint]);
      } else {
        console.error('High-risk scalping push delivery failed:', error instanceof Error ? error.message : 'Unknown delivery error.');
      }
    }
  }));
}

export async function runHighRiskScalpingScan(request: typeof fetch = globalThis.fetch, now = Date.now()) {
  const settings = await getHighRiskScalpingSettings();
  const snapshot = await markets.list();
  const prices = new Map(snapshot.symbols.map((market) => [market.symbol, market.lastPrice]));
  await processPersistedSignalLifecycle(snapshot, now, request);
  if (!settings.enabled || settings.enabledTimeframes.length === 0) {
    return { enabled: false, scanned: 0, created: 0, timeframe: null, scannedAt: new Date(now).toISOString() };
  }
  const enabled = await getEnabledScannerSymbols();
  if (!enabled.length) throw new Error('No admin-enabled Binance perpetual pairs are available for scalping.');
  const intervalBucket = Math.floor(now / (5 * 60_000));
  const offset = (intervalBucket * DEFAULT_BATCH_SIZE) % enabled.length;
  const symbols = Array.from({ length: Math.min(DEFAULT_BATCH_SIZE, enabled.length) }, (_, index) =>
    enabled[(offset + index) % enabled.length]!,
  );
  const btcDirection = (prices.get('BTCUSDT') ?? null) === null
    ? 'NEUTRAL'
    : (snapshot.symbols.find((item) => item.symbol === 'BTCUSDT')?.priceChangePercent24h ?? 0) > 0.2
      ? 'BULLISH'
      : (snapshot.symbols.find((item) => item.symbol === 'BTCUSDT')?.priceChangePercent24h ?? 0) < -0.2
        ? 'BEARISH'
        : 'NEUTRAL';
  let created = 0;
  let scanned = 0;
  const candidates = symbols.flatMap((symbol) =>
    settings.enabledTimeframes.map((timeframe) => ({ symbol, timeframe })),
  );
  let nextCandidate = 0;
  let failed = 0;
  const scanWorker = async () => {
    while (nextCandidate < candidates.length) {
      const { symbol, timeframe } = candidates[nextCandidate++]!;
      const market = snapshot.symbols.find((item) => item.symbol === symbol);
      if (!market?.lastPrice || market.quoteVolume24h < settings.minimumQuoteVolume) continue;
      try {
        const candles = await fetchCandles(symbol, timeframe, request);
        scanned += 1;
        const setup = analyzeHighRiskScalpingSetup({
          symbol,
          timeframe,
          candles,
          price: market.lastPrice,
          btcDirection,
          settings,
          now,
        });
        if (!setup) continue;
        let centralId: string | null = null;
        let legacyId: string | null = null;
        try {
          await retryDatabaseWrite(async () => {
            centralId = null;
            legacyId = null;
            const client = await pool().connect();
            try {
              await client.query('BEGIN');
              const central = await client.query<{ id: string }>(
                `INSERT INTO public.market_signals (
                   signal_key, scanner_type, exchange, strategy_name, symbol, timeframe, side, setup_score,
                   entry_price, entry_zone_low, entry_zone_high, initial_stop, tp1, tp2, tp3,
                   latest_price, last_candle_close_at, candle_open_at, expires_at, entry_expires_at, entry_status,
                   research_snapshot, source_metadata
                 ) VALUES ($1, 'HIGH_RISK', 'BINANCE', 'HIGH_RISK_SCALPING', $2, $3, $4, $5,
                           $6, $7, $8, $9, $10, $11, NULL, $12, NULL, $13,
                           NOW() + ($14 * INTERVAL '1 minute'),
                           NOW() + ($15 * INTERVAL '1 minute'), 'OPEN', $16::JSONB, $17::JSONB)
                 ON CONFLICT DO NOTHING RETURNING id::text`,
                [
                  `HIGH_RISK:${setup.signalKey}`, symbol, timeframe, setup.side, setup.score,
                  setup.entryPrice, setup.entryZoneLow, setup.entryZoneHigh, setup.stop,
                  setup.tp1, setup.tp2, setup.lastPrice, setup.candleOpenAt,
                  settings.signalValidityMinutes[timeframe], settings.entryValidityMinutes[timeframe],
                  JSON.stringify(setup.context),
                  JSON.stringify({ priceSource: 'BINANCE_USDM_TICKER_LAST_PRICE', market: 'USD-M_PERPETUAL' }),
                ],
              );
              if (central.rowCount) {
                centralId = central.rows[0]!.id;
                const legacy = await client.query<{ id: string }>(
                  `INSERT INTO public.high_risk_scalping_signals (
                     signal_key, symbol, timeframe, side, setup_score, entry_price,
                     entry_zone_low, entry_zone_high, initial_stop, tp1, tp2, last_price,
                     candle_open_at, entry_expires_at, expires_at, setup_context
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                             NOW() + ($14 * INTERVAL '1 minute'),
                             NOW() + ($15 * INTERVAL '1 minute'), $16::JSONB)
                   ON CONFLICT DO NOTHING RETURNING id::text`,
              [
                setup.signalKey, symbol, timeframe, setup.side, setup.score,
                setup.entryPrice, setup.entryZoneLow, setup.entryZoneHigh, setup.stop,
                setup.tp1, setup.tp2, setup.lastPrice, setup.candleOpenAt,
                settings.entryValidityMinutes[timeframe], settings.signalValidityMinutes[timeframe],
                JSON.stringify(setup.context),
                ],
              );
              if (!legacy.rowCount) throw new Error('Legacy scalping compatibility record could not be persisted.');
              legacyId = legacy.rows[0]!.id;
              const payload = JSON.stringify({
                scannerType: 'HIGH_RISK',
                symbol,
                timeframe,
                side: setup.side,
                score: setup.score,
              });
              await client.query(
                `INSERT INTO public.signal_events (
                   signal_id, idempotency_key, event_type, payload, event_price, metadata
                 ) VALUES
                   ($1, $2, 'SIGNAL_GENERATED', $4::JSONB, $5, $6::JSONB),
                   ($1, $3, 'ENTRY_OPEN', $4::JSONB, $5, $6::JSONB)
                 ON CONFLICT (idempotency_key) DO NOTHING`,
                [
                  centralId,
                  `HIGH_RISK:${setup.signalKey}:SIGNAL_GENERATED`,
                  `HIGH_RISK:${setup.signalKey}:ENTRY_OPEN`,
                  payload,
                  setup.entryPrice,
                  JSON.stringify({ priceSource: 'BINANCE_USDM_TICKER_LAST_PRICE' }),
                ],
              );
              await client.query(
                `INSERT INTO public.signal_research_snapshots (
                   signal_id, indicator_snapshot, volume_snapshot, market_structure_snapshot,
                   derivatives_snapshot, sentiment_snapshot, data_sources
                 ) VALUES ($1, $2::JSONB, $3::JSONB, $4::JSONB, '{}'::JSONB, '{}'::JSONB, $5::JSONB)
                 ON CONFLICT (signal_id) DO NOTHING`,
                [
                  centralId,
                  JSON.stringify(setup.context),
                  JSON.stringify({ relativeVolume: setup.context.relativeVolume }),
                  JSON.stringify({ breakoutLevel: setup.context.breakoutLevel, timeframe, side: setup.side }),
                  JSON.stringify(['BINANCE_USDM_TICKER_LAST_PRICE', 'BINANCE_USDM_KLINES']),
                ],
              );
              await client.query(
                `INSERT INTO public.signal_user_entries (user_id, signal_id, entered_at)
                 SELECT old.user_id, $1, old.updated_at
                   FROM public.high_risk_scalping_user_states old
                  WHERE old.signal_id = $2
                 ON CONFLICT (user_id, signal_id) DO NOTHING`,
                [centralId, legacyId],
              );
              }
              await client.query('COMMIT');
            } catch (error) {
              try {
                await client.query('ROLLBACK');
              } catch (rollbackError) {
                console.error('High-risk signal persistence rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
              }
              throw error;
            } finally {
              client.release();
            }
          });
        } catch (error) {
          await recordSignalPersistenceFailure('HIGH_RISK', 'persistHighRiskSignal', error);
          throw error;
        }
        if (centralId && legacyId) {
          created += 1;
          await notifyNewSignal(legacyId, setup);
        }
      } catch (error) {
        failed += 1;
        console.error(`High-risk scalping scan failed for ${symbol} ${timeframe}:`, error instanceof Error ? error.message : 'Unknown scan error.');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => scanWorker()));
  return { enabled: true, scanned, created, failed, timeframes: settings.enabledTimeframes, batchSize: symbols.length, enabledPairs: enabled.length, scannedAt: new Date(now).toISOString() };
}

export async function listHighRiskScalpingSignals(userId: number) {
  const settings = await getHighRiskScalpingSettings();
  const result = await query<{
    id: string; signal_key: string; legacy_scalping_signal_id: string | null;
    symbol: string; timeframe: ScalpingTimeframe; side: ScalpingSide;
    setup_score: number; entry_price: string; entry_zone_low: string; entry_zone_high: string;
    initial_stop: string; tp1: string; tp2: string; last_price: string; candle_open_at: string;
    generated_at: string; entry_expires_at: string; expires_at: string; lifecycle_status: StoredScalpingSignal['lifecycleStatus'];
    setup_context: ScalpingSetup['context']; user_state: 'ENTERED' | 'CLOSED' | null;
  }>(
    `SELECT s.id::text, s.signal_key, s.legacy_scalping_signal_id::text, s.symbol,
            s.timeframe, s.side, s.setup_score, s.entry_price::text, s.entry_zone_low::text,
            s.entry_zone_high::text, s.initial_stop::text, s.tp1::text, s.tp2::text,
            s.latest_price::text AS last_price, s.candle_open_at,
            s.generated_at, s.entry_expires_at, s.expires_at, s.status AS lifecycle_status,
            s.research_snapshot AS setup_context, e.status AS user_state
       FROM public.market_signals s
       LEFT JOIN public.signal_user_entries e ON e.signal_id = s.id AND e.user_id = $1
      WHERE s.scanner_type = 'HIGH_RISK'
      ORDER BY s.generated_at DESC LIMIT 200`,
    [userId],
  );
  const signals = result.rows.map((row): StoredScalpingSignal => ({
    id: row.id,
    signalKey: row.signal_key,
    symbol: row.symbol,
    timeframe: row.timeframe,
    side: row.side,
    score: row.setup_score,
    entryPrice: Number(row.entry_price),
    entryZoneLow: Number(row.entry_zone_low),
    entryZoneHigh: Number(row.entry_zone_high),
    stop: Number(row.initial_stop),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    lastPrice: Number(row.last_price),
    candleOpenAt: row.candle_open_at,
    generatedAt: row.generated_at,
    entryExpiresAt: row.entry_expires_at,
    expiresAt: row.expires_at,
    lifecycleStatus: row.lifecycle_status,
    context: row.setup_context,
    userState: row.user_state,
  }));
  return {
    settings,
    active: signals.filter((signal) =>
      ['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(signal.lifecycleStatus) && !signal.userState,
    ),
    entered: signals.filter((signal) => signal.userState !== null),
    history: signals.filter((signal) =>
      !['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(signal.lifecycleStatus) && !signal.userState,
    ),
  };
}

export async function markScalpingSignalEntered(userId: number, signalId: string) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; signal_key: string }>(
      `SELECT id::text, signal_key
         FROM public.market_signals
        WHERE id = $1 AND scanner_type = 'HIGH_RISK'
          AND status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT')
          AND entry_expires_at > NOW()
        FOR UPDATE`,
      [signalId],
    );
    if (!result.rowCount) throw new Error('This entry opportunity has expired or is no longer active.');
    await client.query(
      `INSERT INTO public.signal_user_entries (user_id, signal_id, status)
       VALUES ($1, $2, 'ENTERED')
       ON CONFLICT (user_id, signal_id) DO UPDATE
         SET status = 'ENTERED', entered_at = NOW(), updated_at = NOW()`,
      [userId, signalId],
    );
    await client.query(
      `INSERT INTO public.signal_events (
         signal_id, idempotency_key, event_type, payload, event_price, metadata, actor_user_id
       ) VALUES ($1, $2, 'ENTRY_MARKED_AS_ENTERED', $3::JSONB, NULL, $4::JSONB, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        signalId,
        `${result.rows[0]!.signal_key}:USER:${userId}:ENTRY_MARKED_AS_ENTERED`,
        JSON.stringify({ state: 'ENTERED' }),
        JSON.stringify({ scope: 'per-user', tradeExecution: false }),
        userId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getScalpingPushPreference(userId: number) {
  const result = await query<{ push_enabled: boolean }>(
    'SELECT push_enabled FROM public.high_risk_scalping_preferences WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.push_enabled ?? false;
}

export async function setScalpingPushPreference(userId: number, enabled: boolean) {
  if (enabled) {
    const result = await query<{ push_enabled: boolean }>(
      'SELECT push_enabled FROM public.user_notification_preferences WHERE user_id = $1',
      [userId],
    );
    if (!result.rows[0]?.push_enabled) throw new Error('Enable browser push notifications in Notification settings first.');
  }
  await query(
    `INSERT INTO public.high_risk_scalping_preferences (user_id, push_enabled, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, updated_at = NOW()`,
    [userId, enabled],
  );
}
