import { sendNotification, setVapidDetails } from 'web-push';
import type { PoolClient } from 'pg';
import { pool, query, recordSignalPersistenceFailure, retryDatabaseWrite } from './db';
import { processPersistedSignalLifecycle } from './signal-lifecycle';
import { TABLE_PAGE_SIZE } from './pagination';
import type {
  MarketScannerCandidate,
  ScannerConfiguration,
} from '../smartexit/apps/api/src/services/market-scanner';
import type { FuturesMarketSnapshot } from '../smartexit/apps/api/src/services/binance-futures-markets';

const TIMEFRAMES: ScannerConfiguration['timeframe'][] = ['5m', '15m', '1h', '4h'];
const DEFAULT_VALIDITY: Record<ScannerConfiguration['timeframe'], number> = {
  '5m': 10,
  '15m': 25,
  '1h': 60,
  '4h': 240,
};
const PUSH_SERVICE_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'wns.windows.com',
]);

export function isSupportedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (PUSH_SERVICE_HOSTS.has(host) || host.endsWith('.notify.windows.com') || host.endsWith('.wns.windows.com'));
  } catch {
    return false;
  }
}

export interface NotificationSystemSettings {
  enabled: boolean;
  validityMinutes: Record<ScannerConfiguration['timeframe'], number>;
  minimumSetupScore: number;
  highConvictionScore: number;
  entryZoneAtrFraction: number;
}

export interface NotificationPreferences {
  push_enabled: boolean;
  sound_enabled: boolean;
  long_enabled: boolean;
  short_enabled: boolean;
  high_conviction_enabled: boolean;
  tp1_enabled: boolean;
  tp2_enabled: boolean;
  tp3_enabled: boolean;
  stop_loss_enabled: boolean;
  expiry_enabled: boolean;
  minimum_setup_score: number;
  alarm_volume: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
  do_not_disturb: boolean;
}

type SignalStatus =
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

const EVENT_PREFERENCE: Record<string, keyof NotificationPreferences> = {
  TP1_HIT: 'tp1_enabled',
  TP2_HIT: 'tp2_enabled',
  TP3_HIT: 'tp3_enabled',
  STOP_LOSS_HIT: 'stop_loss_enabled',
  SIGNAL_EXPIRED: 'expiry_enabled',
  ENTRY_INVALIDATED: 'expiry_enabled',
};

export function defaultNotificationSystemSettings(): NotificationSystemSettings {
  return {
    enabled: true,
    validityMinutes: DEFAULT_VALIDITY,
    minimumSetupScore: 60,
    highConvictionScore: 80,
    entryZoneAtrFraction: 0.25,
  };
}

export async function getNotificationSystemSettings(): Promise<NotificationSystemSettings> {
  const result = await query<{
    enabled: boolean;
    validity_minutes: Record<string, unknown>;
    minimum_setup_score: number;
    high_conviction_score: number;
    entry_zone_atr_fraction: string | number;
  }>(
    `SELECT enabled, validity_minutes, minimum_setup_score, high_conviction_score, entry_zone_atr_fraction
       FROM public.notification_system_settings WHERE singleton = TRUE`,
  );
  const row = result.rows[0];
  if (!row) return defaultNotificationSystemSettings();
  const validityMinutes = { ...DEFAULT_VALIDITY };
  for (const timeframe of TIMEFRAMES) {
    const value = Number(row.validity_minutes?.[timeframe]);
    if (Number.isInteger(value) && value >= 1 && value <= 1440) validityMinutes[timeframe] = value;
  }
  return {
    enabled: row.enabled,
    validityMinutes,
    minimumSetupScore: row.minimum_setup_score,
    highConvictionScore: row.high_conviction_score,
    entryZoneAtrFraction: Number(row.entry_zone_atr_fraction),
  };
}

export async function updateNotificationPreferences(
  userId: number,
  preferences: Omit<NotificationPreferences, 'quiet_hours_start' | 'quiet_hours_end'> & {
    quiet_hours_start: string;
    quiet_hours_end: string;
  },
) {
  await query(
    `INSERT INTO public.user_notification_preferences (
       user_id, push_enabled, sound_enabled, long_enabled, short_enabled,
       high_conviction_enabled, tp1_enabled, tp2_enabled, tp3_enabled,
       stop_loss_enabled, expiry_enabled, minimum_setup_score, alarm_volume,
       quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
       quiet_hours_timezone, do_not_disturb, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       push_enabled = EXCLUDED.push_enabled, sound_enabled = EXCLUDED.sound_enabled,
       long_enabled = EXCLUDED.long_enabled, short_enabled = EXCLUDED.short_enabled,
       high_conviction_enabled = EXCLUDED.high_conviction_enabled,
       tp1_enabled = EXCLUDED.tp1_enabled, tp2_enabled = EXCLUDED.tp2_enabled,
       tp3_enabled = EXCLUDED.tp3_enabled, stop_loss_enabled = EXCLUDED.stop_loss_enabled,
       expiry_enabled = EXCLUDED.expiry_enabled, minimum_setup_score = EXCLUDED.minimum_setup_score,
       alarm_volume = EXCLUDED.alarm_volume, quiet_hours_enabled = EXCLUDED.quiet_hours_enabled,
       quiet_hours_start = EXCLUDED.quiet_hours_start, quiet_hours_end = EXCLUDED.quiet_hours_end,
       quiet_hours_timezone = EXCLUDED.quiet_hours_timezone,
       do_not_disturb = EXCLUDED.do_not_disturb, updated_at = NOW()`,
    [
      userId,
      preferences.push_enabled,
      preferences.sound_enabled,
      preferences.long_enabled,
      preferences.short_enabled,
      preferences.high_conviction_enabled,
      preferences.tp1_enabled,
      preferences.tp2_enabled,
      preferences.tp3_enabled,
      preferences.stop_loss_enabled,
      preferences.expiry_enabled,
      preferences.minimum_setup_score,
      preferences.alarm_volume,
      preferences.quiet_hours_enabled,
      preferences.quiet_hours_start,
      preferences.quiet_hours_end,
      preferences.quiet_hours_timezone,
      preferences.do_not_disturb,
    ],
  );
}

export async function getNotificationPreferences(userId: number) {
  await query(
    'INSERT INTO public.user_notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
  const result = await query<NotificationPreferences>(
    `SELECT push_enabled, sound_enabled, long_enabled, short_enabled, high_conviction_enabled,
            tp1_enabled, tp2_enabled, tp3_enabled, stop_loss_enabled, expiry_enabled,
            minimum_setup_score, alarm_volume, quiet_hours_enabled,
            to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
            to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
            quiet_hours_timezone, do_not_disturb
       FROM public.user_notification_preferences WHERE user_id = $1`,
    [userId],
  );
  if (!result.rows[0]) throw new Error('Notification preferences could not be loaded.');
  return { ...result.rows[0], alarm_volume: Number(result.rows[0].alarm_volume) };
}

function stableSignalKey(candidate: MarketScannerCandidate) {
  const closeAt = Date.parse(candidate.lastCandleCloseAt ?? '');
  if (!Number.isFinite(closeAt)) throw new Error(`Signal for ${candidate.symbol} has no valid candle timestamp.`);
  return `${candidate.symbol}:${candidate.timeframe}:${candidate.side}:${closeAt}`;
}

async function insertSignal(
  client: PoolClient,
  candidate: MarketScannerCandidate,
  settings: NotificationSystemSettings,
) {
  if (
    candidate.status !== 'READY' ||
    (candidate.side !== 'LONG' && candidate.side !== 'SHORT') ||
    !candidate.setup ||
    candidate.score.value === null ||
    candidate.score.value < settings.minimumSetupScore ||
    !candidate.lastCandleCloseAt ||
    ![
      candidate.setup.entryPrice,
      candidate.setup.initialStop,
      candidate.setup.tp1,
      candidate.setup.tp2,
      candidate.setup.tp3,
      candidate.price ?? candidate.setup.entryPrice,
    ].every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(candidate.supertrend.atr) ||
    !candidate.supertrend.atr
  ) return null;

  const signalKey = stableSignalKey(candidate);
  const atrDelta = candidate.supertrend.atr * settings.entryZoneAtrFraction;
  const entryZoneLow = Math.max(candidate.setup.entryPrice * 0.000001, candidate.setup.entryPrice - atrDelta);
  const entryZoneHigh = candidate.setup.entryPrice + atrDelta;
  const validityMinutes = settings.validityMinutes[candidate.timeframe] ?? DEFAULT_VALIDITY[candidate.timeframe];
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.market_signals (
       signal_key, scanner_type, exchange, strategy_name, symbol, timeframe, side, setup_score,
       entry_price, entry_zone_low, entry_zone_high,
       initial_stop, tp1, tp2, tp3, latest_price, last_candle_close_at,
       expires_at, entry_expires_at, entry_status, source_metadata
     ) VALUES ($1, 'STANDARD', 'BINANCE', 'STANDARD_TECHNICAL', $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, NOW() + ($15 * INTERVAL '1 minute'),
               NOW() + ($15 * INTERVAL '1 minute'), 'OPEN',
               jsonb_build_object('priceSource', 'BINANCE_USDM_TICKER_LAST_PRICE'))
     ON CONFLICT (signal_key) DO NOTHING
     RETURNING id`,
    [
      signalKey,
      candidate.symbol,
      candidate.timeframe,
      candidate.side,
      Math.round(candidate.score.value),
      candidate.setup.entryPrice,
      entryZoneLow,
      entryZoneHigh,
      candidate.setup.initialStop,
      candidate.setup.tp1,
      candidate.setup.tp2,
      candidate.setup.tp3,
      candidate.price ?? candidate.setup.entryPrice,
      candidate.lastCandleCloseAt,
      validityMinutes,
    ],
  );
  if (!inserted.rowCount) {
    const updated = await client.query<{ id: string; signal_update_version: number }>(
      `UPDATE public.market_signals
          SET setup_score = $2, last_signal_updated_at = NOW(),
              signal_update_version = signal_update_version + 1
        WHERE signal_key = $1 AND ABS(setup_score - $2) >= 10
          AND (last_signal_updated_at IS NULL OR last_signal_updated_at < NOW() - INTERVAL '5 minutes')
        RETURNING id, signal_update_version`,
      [signalKey, Math.round(candidate.score.value)],
    );
    await client.query(
      'UPDATE public.market_signals SET last_seen_at = NOW(), latest_price = $2, repeated_scan_count = repeated_scan_count + 1 WHERE signal_key = $1',
      [signalKey, candidate.price ?? candidate.setup.entryPrice],
    );
    if (updated.rowCount) {
      await client.query(
        `INSERT INTO public.signal_events (signal_id, idempotency_key, event_type, payload)
         VALUES ($1, $2, 'SIGNAL_UPDATED', $3::JSONB)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          updated.rows[0]!.id,
          `${signalKey}:SIGNAL_UPDATED:${updated.rows[0]!.signal_update_version}`,
          JSON.stringify({
            symbol: candidate.symbol,
            timeframe: candidate.timeframe,
            side: candidate.side,
            score: Math.round(candidate.score.value),
            highConviction: candidate.score.value >= settings.highConvictionScore,
          }),
        ],
      );
    }
    return null;
  }

  const id = inserted.rows[0]!.id;
  const generatedPayload = JSON.stringify({
    scannerType: 'STANDARD',
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    side: candidate.side,
    score: Math.round(candidate.score.value),
    highConviction: candidate.score.value >= settings.highConvictionScore,
  });
  await client.query(
    `INSERT INTO public.signal_events (signal_id, idempotency_key, event_type, payload, event_price, metadata)
     VALUES
       ($1, $2, 'NEW_SIGNAL', $4::JSONB, $5, $6::JSONB),
       ($1, $3, 'SIGNAL_GENERATED', $4::JSONB, $5, $6::JSONB),
       ($1, $7, 'ENTRY_OPEN', $4::JSONB, $5, $6::JSONB)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      `${signalKey}:NEW_SIGNAL`,
      `${signalKey}:SIGNAL_GENERATED`,
      generatedPayload,
      candidate.setup.entryPrice,
      JSON.stringify({ priceSource: 'BINANCE_USDM_TICKER_LAST_PRICE' }),
      `${signalKey}:ENTRY_OPEN`,
    ],
  );
  await client.query(
    `INSERT INTO public.signal_research_snapshots (
       signal_id, indicator_snapshot, volume_snapshot, market_structure_snapshot,
       derivatives_snapshot, sentiment_snapshot, data_sources
     ) VALUES ($1, $2::JSONB, $3::JSONB, $4::JSONB, '{}'::JSONB, '{}'::JSONB, $5::JSONB)
     ON CONFLICT (signal_id) DO NOTHING`,
    [
      id,
      JSON.stringify(candidate),
      JSON.stringify({ quoteVolume24h: candidate.quoteVolume24h ?? null }),
      JSON.stringify({ timeframe: candidate.timeframe, side: candidate.side, rationale: candidate.rationale }),
      JSON.stringify(['BINANCE_USDM_TICKER_LAST_PRICE', 'BINANCE_USDM_KLINES']),
    ],
  );
  return id;
}

export async function persistSignalScan(
  candidates: MarketScannerCandidate[],
  settings: NotificationSystemSettings,
): Promise<{ created: number; createdSignalIds: string[]; signals: Record<string, { id: string; generatedAt: string; expiresAt: string; status: SignalStatus }> }> {
  let createdSignalIds: string[] = [];
  try {
    await retryDatabaseWrite(async () => {
      createdSignalIds = [];
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        for (const candidate of candidates) {
          const createdId = await insertSignal(client, candidate, settings);
          if (createdId) createdSignalIds.push(createdId);
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Standard signal persistence rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
        }
        throw error;
      } finally {
        client.release();
      }
    });
  } catch (error) {
    await recordSignalPersistenceFailure('STANDARD', 'persistSignalScan', error);
    throw error;
  }

  try {
    await dispatchSignalEvents(settings);
  } catch (error) {
    console.error('Standard signal event dispatch failed; pending outbox events remain retryable:', error instanceof Error ? error.message : 'Unknown event dispatch error.');
  }
  return { created: createdSignalIds.length, createdSignalIds, signals: await getPersistedSignalMetadata(candidates) };
}

export async function getPersistedSignalMetadata(candidates: MarketScannerCandidate[]) {
  const signalCandidates = candidates.filter(
    (candidate) => candidate.status === 'READY' && candidate.side !== 'WAIT' && candidate.lastCandleCloseAt,
  );
  const keys = signalCandidates.map(stableSignalKey);
  if (!keys.length) return {};
  const result = await query<{
    signal_key: string;
    id: string;
    generated_at: string;
    expires_at: string;
    status: SignalStatus;
  }>(
    `SELECT signal_key, id, generated_at, expires_at, status
       FROM public.market_signals WHERE signal_key = ANY($1::VARCHAR[])`,
    [keys],
  );
  return Object.fromEntries(result.rows.map((row) => [
    row.signal_key,
    { id: row.id, generatedAt: row.generated_at, expiresAt: row.expires_at, status: row.status },
  ]));
}

export async function processSignalLifecycle(snapshot: FuturesMarketSnapshot) {
  await processPersistedSignalLifecycle(snapshot);
}

function isWithinQuietHours(preferences: NotificationPreferences, now = new Date()) {
  if (!preferences.quiet_hours_enabled) return false;
  let localHour: number;
  let localMinute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: preferences.quiet_hours_timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    localHour = Number(parts.find((part) => part.type === 'hour')?.value);
    localMinute = Number(parts.find((part) => part.type === 'minute')?.value);
  } catch (error) {
    console.error('Invalid quiet-hours timezone stored for a user:', error instanceof Error ? error.message : 'Unknown error');
    return true;
  }
  const current = localHour * 60 + localMinute;
  const start = preferences.quiet_hours_start.slice(0, 5).split(':').map(Number);
  const end = preferences.quiet_hours_end.slice(0, 5).split(':').map(Number);
  const startMinutes = start[0]! * 60 + start[1]!;
  const endMinutes = end[0]! * 60 + end[1]!;
  if (startMinutes === endMinutes) return true;
  return startMinutes < endMinutes
    ? current >= startMinutes && current < endMinutes
    : current >= startMinutes || current < endMinutes;
}

function isEligibleForEvent(
  preferences: NotificationPreferences,
  eventType: string,
  side: string,
  score: number,
  highConviction: boolean,
) {
  if (score < preferences.minimum_setup_score) return false;
  if (eventType === 'NEW_SIGNAL') {
    const directionEnabled = side === 'LONG' ? preferences.long_enabled : preferences.short_enabled;
    return directionEnabled || (highConviction && preferences.high_conviction_enabled);
  }
  if (eventType === 'SIGNAL_UPDATED') {
    const directionEnabled = side === 'LONG' ? preferences.long_enabled : preferences.short_enabled;
    return directionEnabled || (highConviction && preferences.high_conviction_enabled);
  }
  const setting = EVENT_PREFERENCE[eventType];
  return setting ? preferences[setting] === true : true;
}

async function dispatchSignalEvents(settings: NotificationSystemSettings) {
  const events = await query<{
    id: string;
    signal_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    symbol: string;
    side: string;
    setup_score: number;
    entry_price: string;
    initial_stop: string;
    tp1: string;
    tp2: string;
    tp3: string;
  }>(
    `SELECT e.id, e.signal_id, e.event_type, e.payload, s.symbol, s.side, s.setup_score,
            s.entry_price, s.initial_stop, s.tp1, s.tp2, s.tp3
       FROM public.signal_events e
       JOIN public.market_signals s ON s.id = e.signal_id
      WHERE e.processed_at IS NULL
      ORDER BY e.id ASC LIMIT 100`,
  );
  for (const event of events.rows) {
    if (!settings.enabled) {
      await query('UPDATE public.signal_events SET processed_at = NOW() WHERE id = $1', [event.id]);
      continue;
    }
    const highConviction = event.payload.highConviction === true;
    const users = await query<NotificationPreferences & { user_id: number }>(
      `SELECT u.id AS user_id,
              COALESCE(p.push_enabled, FALSE) AS push_enabled,
              COALESCE(p.sound_enabled, FALSE) AS sound_enabled,
              COALESCE(p.long_enabled, TRUE) AS long_enabled,
              COALESCE(p.short_enabled, TRUE) AS short_enabled,
              COALESCE(p.high_conviction_enabled, TRUE) AS high_conviction_enabled,
              COALESCE(p.tp1_enabled, TRUE) AS tp1_enabled,
              COALESCE(p.tp2_enabled, TRUE) AS tp2_enabled,
              COALESCE(p.tp3_enabled, TRUE) AS tp3_enabled,
              COALESCE(p.stop_loss_enabled, TRUE) AS stop_loss_enabled,
              COALESCE(p.expiry_enabled, TRUE) AS expiry_enabled,
              COALESCE(p.minimum_setup_score, 60) AS minimum_setup_score,
              COALESCE(p.alarm_volume, 0.70) AS alarm_volume,
              COALESCE(p.quiet_hours_enabled, FALSE) AS quiet_hours_enabled,
              COALESCE(to_char(p.quiet_hours_start, 'HH24:MI'), '22:00') AS quiet_hours_start,
              COALESCE(to_char(p.quiet_hours_end, 'HH24:MI'), '07:00') AS quiet_hours_end,
              COALESCE(p.quiet_hours_timezone, 'UTC') AS quiet_hours_timezone,
              COALESCE(p.do_not_disturb, FALSE) AS do_not_disturb
         FROM public.users u
         LEFT JOIN public.user_notification_preferences p ON p.user_id = u.id
         JOIN public.subscriptions entitlement ON entitlement.user_id = u.id
        WHERE u.is_active = 1 AND u.is_email_verified = 1
          AND (entitlement.premium_expires_at > NOW()
            OR (entitlement.premium_started_at IS NULL AND entitlement.trial_expires_at > NOW()))`,
    );

    for (const user of users.rows) {
      if (!isEligibleForEvent(user, event.event_type, event.side, event.setup_score, highConviction)) continue;
      const inserted = await query<{ id: string }>(
        `INSERT INTO public.user_signal_notifications (user_id, signal_id, event_id)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, event_id) DO NOTHING RETURNING id`,
        [user.user_id, event.signal_id, event.id],
      );
      let notificationId = inserted.rows[0]?.id;
      if (!notificationId) {
        const existing = await query<{ id: string }>(
          'SELECT id FROM public.user_signal_notifications WHERE user_id = $1 AND event_id = $2',
          [user.user_id, event.id],
        );
        notificationId = existing.rows[0]?.id;
      }
      if (!notificationId || !user.push_enabled || user.do_not_disturb || isWithinQuietHours(user)) continue;
      await query(
        `INSERT INTO public.push_delivery_attempts (notification_id, subscription_id)
         SELECT $1, id FROM public.push_subscriptions WHERE user_id = $2
         ON CONFLICT (notification_id, subscription_id) DO NOTHING`,
        [notificationId, user.user_id],
      );
    }
    await query('UPDATE public.signal_events SET processed_at = NOW() WHERE id = $1', [event.id]);
  }
  try {
    await deliverPendingPushes();
  } catch (error) {
    console.error('Signal events were saved, but push delivery processing failed:', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function deliverPendingPushes() {
  const client = await pool().connect();
  let deliveries: Array<{
    notification_id: string;
    subscription_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    signal_id: string;
    user_id: number;
    event_type: string;
    payload: Record<string, unknown>;
    symbol: string;
    side: string;
    setup_score: number;
    entry_price: string;
    initial_stop: string;
    tp1: string;
    tp2: string;
    tp3: string;
    push_enabled: boolean;
    long_enabled: boolean;
    short_enabled: boolean;
    high_conviction_enabled: boolean;
    tp1_enabled: boolean;
    tp2_enabled: boolean;
    tp3_enabled: boolean;
    stop_loss_enabled: boolean;
    expiry_enabled: boolean;
    minimum_setup_score: number;
    alarm_volume: number;
    quiet_hours_enabled: boolean;
    quiet_hours_start: string;
    quiet_hours_end: string;
    quiet_hours_timezone: string;
    do_not_disturb: boolean;
  }> = [];
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{
      notification_id: string;
      subscription_id: string;
    }>(
      `WITH due AS (
         SELECT d.notification_id, d.subscription_id
           FROM public.push_delivery_attempts d
           JOIN public.user_signal_notifications n ON n.id = d.notification_id
           JOIN public.subscriptions entitlement ON entitlement.user_id = n.user_id
          WHERE d.attempts < 4
            AND (entitlement.premium_expires_at > NOW()
              OR (entitlement.premium_started_at IS NULL AND entitlement.trial_expires_at > NOW()))
            AND (
              d.status = 'PENDING'
              OR (d.status = 'FAILED' AND d.updated_at < NOW() - INTERVAL '30 seconds')
              OR (d.status = 'SENDING' AND d.updated_at < NOW() - INTERVAL '5 minutes')
            )
          ORDER BY d.updated_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 50
       )
       UPDATE public.push_delivery_attempts d
          SET status = 'SENDING', attempts = d.attempts + 1, updated_at = NOW()
         FROM due
        WHERE d.notification_id = due.notification_id AND d.subscription_id = due.subscription_id
       RETURNING d.notification_id, d.subscription_id`,
    );
    if (claimed.rows.length) {
      const keys = claimed.rows.map((row) => ({
        notification_id: row.notification_id,
        subscription_id: row.subscription_id,
      }));
      const rows = await client.query<typeof deliveries[number]>(
        `SELECT d.notification_id, d.subscription_id, n.signal_id, n.user_id,
                p.endpoint, p.p256dh, p.auth, e.event_type, e.payload,
                s.symbol, s.side, s.setup_score, s.entry_price, s.initial_stop, s.tp1, s.tp2, s.tp3,
                COALESCE(pref.push_enabled, FALSE) AS push_enabled,
                COALESCE(pref.long_enabled, TRUE) AS long_enabled,
                COALESCE(pref.short_enabled, TRUE) AS short_enabled,
                COALESCE(pref.high_conviction_enabled, TRUE) AS high_conviction_enabled,
                COALESCE(pref.tp1_enabled, TRUE) AS tp1_enabled,
                COALESCE(pref.tp2_enabled, TRUE) AS tp2_enabled,
                COALESCE(pref.tp3_enabled, TRUE) AS tp3_enabled,
                COALESCE(pref.stop_loss_enabled, TRUE) AS stop_loss_enabled,
                COALESCE(pref.expiry_enabled, TRUE) AS expiry_enabled,
                COALESCE(pref.minimum_setup_score, 60) AS minimum_setup_score,
                COALESCE(pref.alarm_volume, 0.70) AS alarm_volume,
                COALESCE(pref.quiet_hours_enabled, FALSE) AS quiet_hours_enabled,
                COALESCE(to_char(pref.quiet_hours_start, 'HH24:MI'), '22:00') AS quiet_hours_start,
                COALESCE(to_char(pref.quiet_hours_end, 'HH24:MI'), '07:00') AS quiet_hours_end,
                COALESCE(pref.quiet_hours_timezone, 'UTC') AS quiet_hours_timezone,
                COALESCE(pref.do_not_disturb, FALSE) AS do_not_disturb
           FROM public.push_delivery_attempts d
           JOIN public.user_signal_notifications n ON n.id = d.notification_id
           JOIN public.push_subscriptions p ON p.id = d.subscription_id
           JOIN public.signal_events e ON e.id = n.event_id
           JOIN public.market_signals s ON s.id = n.signal_id
           LEFT JOIN public.user_notification_preferences pref ON pref.user_id = n.user_id
          WHERE (d.notification_id, d.subscription_id) IN (
            SELECT item.notification_id, item.subscription_id
            FROM jsonb_to_recordset($1::JSONB) AS item(notification_id BIGINT, subscription_id BIGINT)
          )`,
        [JSON.stringify(keys)],
      );
      deliveries = rows.rows;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!deliveries.length) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:security@ethcryptohub.com';
  if (!publicKey || !privateKey) {
    await query(
      `UPDATE public.push_delivery_attempts SET status = 'FAILED',
         last_error = 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not configured.', updated_at = NOW()
       WHERE status = 'SENDING' AND (notification_id, subscription_id) IN (
         SELECT item.notification_id, item.subscription_id
         FROM jsonb_to_recordset($1::JSONB) AS item(notification_id BIGINT, subscription_id BIGINT)
       )`,
      [JSON.stringify(deliveries.map((row) => ({
        notification_id: row.notification_id,
        subscription_id: row.subscription_id,
      })))],
    );
    console.error('Web Push delivery skipped because VAPID keys are not configured.');
    return;
  }

  try {
    setVapidDetails(subject, publicKey, privateKey);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Invalid VAPID configuration.';
    await query(
      `UPDATE public.push_delivery_attempts SET status = 'FAILED', last_error = $1, updated_at = NOW()
       WHERE status = 'SENDING' AND (notification_id, subscription_id) IN (
         SELECT item.notification_id, item.subscription_id
         FROM jsonb_to_recordset($2::JSONB) AS item(notification_id BIGINT, subscription_id BIGINT)
       )`,
      [
        message,
        JSON.stringify(deliveries.map((row) => ({
          notification_id: row.notification_id,
          subscription_id: row.subscription_id,
        })))],
    );
    console.error('Web Push delivery skipped because VAPID configuration is invalid:', message);
    return;
  }
  await Promise.all(deliveries.map(async (delivery) => {
    const preferences: NotificationPreferences = {
      push_enabled: delivery.push_enabled,
      sound_enabled: false,
      long_enabled: delivery.long_enabled,
      short_enabled: delivery.short_enabled,
      high_conviction_enabled: delivery.high_conviction_enabled,
      tp1_enabled: delivery.tp1_enabled,
      tp2_enabled: delivery.tp2_enabled,
      tp3_enabled: delivery.tp3_enabled,
      stop_loss_enabled: delivery.stop_loss_enabled,
      expiry_enabled: delivery.expiry_enabled,
      minimum_setup_score: delivery.minimum_setup_score,
      alarm_volume: Number(delivery.alarm_volume),
      quiet_hours_enabled: delivery.quiet_hours_enabled,
      quiet_hours_start: delivery.quiet_hours_start,
      quiet_hours_end: delivery.quiet_hours_end,
      quiet_hours_timezone: delivery.quiet_hours_timezone,
      do_not_disturb: delivery.do_not_disturb,
    };
    if (
      !preferences.push_enabled ||
      preferences.do_not_disturb ||
      isWithinQuietHours(preferences) ||
      !isEligibleForEvent(
        preferences,
        delivery.event_type,
        delivery.side,
        delivery.setup_score,
        delivery.payload.highConviction === true,
      )
    ) {
      await query(
        'DELETE FROM public.push_delivery_attempts WHERE notification_id = $1 AND subscription_id = $2',
        [delivery.notification_id, delivery.subscription_id],
      );
      return;
    }
    if (!isSupportedPushEndpoint(delivery.endpoint)) {
      await query('DELETE FROM public.push_subscriptions WHERE id = $1', [delivery.subscription_id]);
      console.error('Removed a push subscription with an unsupported delivery host.');
      return;
    }
    const body = JSON.stringify({
      title: `${delivery.side} ${delivery.symbol} signal`,
      body: `${delivery.event_type.replaceAll('_', ' ')} · score ${delivery.setup_score}`,
      url: `/signals/${delivery.signal_id}?notification=${delivery.notification_id}`,
      eventId: delivery.notification_id,
      data: {
        side: delivery.side,
        entry: delivery.entry_price,
        stop: delivery.initial_stop,
        targets: [delivery.tp1, delivery.tp2, delivery.tp3],
      },
    });
    try {
      await sendNotification({
        endpoint: delivery.endpoint,
        keys: { p256dh: delivery.p256dh, auth: delivery.auth },
      }, body, { TTL: 3600 });
      await query(
        `UPDATE public.push_delivery_attempts
            SET status = 'SENT', delivered_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE notification_id = $1 AND subscription_id = $2`,
        [delivery.notification_id, delivery.subscription_id],
      );
      await query('UPDATE public.push_subscriptions SET last_used_at = NOW() WHERE id = $1', [delivery.subscription_id]);
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        await query('DELETE FROM public.push_subscriptions WHERE id = $1', [delivery.subscription_id]);
        return;
      }
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown push delivery error.';
      await query(
        `UPDATE public.push_delivery_attempts
            SET status = 'FAILED', last_error = $3, updated_at = NOW()
          WHERE notification_id = $1 AND subscription_id = $2`,
        [delivery.notification_id, delivery.subscription_id, message],
      );
      console.error('Web Push delivery failed:', message);
    }
  }));
}

export async function flushSignalNotifications() {
  await dispatchSignalEvents(await getNotificationSystemSettings());
}

export async function upsertPushSubscription(
  userId: number,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string }; deviceType: string },
) {
  const count = await query<{ count: string }>(
    'SELECT COUNT(*)::TEXT AS count FROM public.push_subscriptions WHERE user_id = $1',
    [userId],
  );
  if (Number(count.rows[0]?.count ?? 0) >= 10) {
    const existing = await query(
      'SELECT id FROM public.push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, subscription.endpoint],
    );
    if (!existing.rowCount) throw new Error('A maximum of 10 browser subscriptions is allowed per account.');
  }
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, device_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         device_type = EXCLUDED.device_type, updated_at = NOW()
       WHERE public.push_subscriptions.user_id = EXCLUDED.user_id`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription.deviceType],
    );
    if (!saved.rowCount) throw new Error('This browser subscription is already associated with another account.');
    await client.query(
      `INSERT INTO public.user_notification_preferences (user_id, push_enabled, updated_at)
       VALUES ($1, TRUE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = TRUE, updated_at = NOW()`,
      [userId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function removePushSubscription(userId: number, endpoint: string) {
  await query(
    'DELETE FROM public.push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, endpoint],
  );
  await query(
    `UPDATE public.user_notification_preferences SET push_enabled = EXISTS (
       SELECT 1 FROM public.push_subscriptions WHERE user_id = $1
     ), updated_at = NOW() WHERE user_id = $1`,
    [userId],
  );
}

export async function disablePushForUser(userId: number) {
  await query('DELETE FROM public.push_subscriptions WHERE user_id = $1', [userId]);
  await query(
    'UPDATE public.user_notification_preferences SET push_enabled = FALSE, updated_at = NOW() WHERE user_id = $1',
    [userId],
  );
}

export async function updateGlobalNotificationSettings(settings: NotificationSystemSettings) {
  await query(
    `UPDATE public.notification_system_settings
        SET enabled = $1, validity_minutes = $2::JSONB, minimum_setup_score = $3,
            high_conviction_score = $4, entry_zone_atr_fraction = $5, updated_at = NOW()
      WHERE singleton = TRUE`,
    [
      settings.enabled,
      JSON.stringify(settings.validityMinutes),
      settings.minimumSetupScore,
      settings.highConvictionScore,
      settings.entryZoneAtrFraction,
    ],
  );
}

export async function getNotificationAdminStats(page: number) {
  const offset = (page - 1) * TABLE_PAGE_SIZE;
  const [signals, pending, deliveries, failedAttempts, failedAttemptsTotal] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM public.market_signals
        WHERE generated_at >= NOW() - INTERVAL '24 hours'`,
    ),
    query<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM public.signal_events WHERE processed_at IS NULL',
    ),
    query<{ failed: string; sent: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'FAILED')::TEXT AS failed,
              COUNT(*) FILTER (WHERE status = 'SENT')::TEXT AS sent
         FROM public.push_delivery_attempts WHERE updated_at >= NOW() - INTERVAL '24 hours'`,
    ),
    query<{
      symbol: string;
      event_type: string;
      attempts: number;
      last_error: string | null;
      updated_at: string;
    }>(
      `SELECT s.symbol, e.event_type, d.attempts, d.last_error, d.updated_at
         FROM public.push_delivery_attempts d
         JOIN public.user_signal_notifications n ON n.id = d.notification_id
         JOIN public.signal_events e ON e.id = n.event_id
         JOIN public.market_signals s ON s.id = n.signal_id
        WHERE d.status = 'FAILED' AND d.updated_at >= NOW() - INTERVAL '24 hours'
        ORDER BY d.updated_at DESC, d.notification_id DESC, d.subscription_id DESC
        LIMIT $1 OFFSET $2`,
      [TABLE_PAGE_SIZE, offset],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM public.push_delivery_attempts
        WHERE status = 'FAILED' AND updated_at >= NOW() - INTERVAL '24 hours'`,
    ),
  ]);
  const duplicates = await query<{ count: string }>(
    'SELECT COALESCE(SUM(repeated_scan_count), 0)::TEXT AS count FROM public.market_signals',
  );
  return {
    signalsLast24Hours: Number(signals.rows[0]?.count ?? 0),
    unprocessedEvents: Number(pending.rows[0]?.count ?? 0),
    failedPushAttemptsLast24Hours: Number(deliveries.rows[0]?.failed ?? 0),
    sentPushAttemptsLast24Hours: Number(deliveries.rows[0]?.sent ?? 0),
    repeatedSignalScans: Number(duplicates.rows[0]?.count ?? 0),
    recentFailedPushAttempts: failedAttempts.rows,
    recentFailedPushAttemptsTotal: Number(failedAttemptsTotal.rows[0]?.count ?? 0),
  };
}

export function signalKeyForCandidate(candidate: MarketScannerCandidate) {
  return stableSignalKey(candidate);
}
