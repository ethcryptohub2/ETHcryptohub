import { pool, query } from './db';

export type SignalScannerType = 'STANDARD' | 'HIGH_RISK';

export interface SignalHistoryFilters {
  page: number;
  pageSize: number;
  scannerType?: SignalScannerType;
  side?: 'LONG' | 'SHORT';
  timeframe?: string;
  status?: string;
  symbol?: string;
  strategy?: string;
  from?: string;
  to?: string;
  successful?: boolean;
}

function filterSql(filters: SignalHistoryFilters) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  const add = (clause: (index: number) => string, value: unknown) => {
    values.push(value);
    clauses.push(clause(values.length));
  };
  if (filters.scannerType) add((i) => `s.scanner_type = $${i}`, filters.scannerType);
  if (filters.side) add((i) => `s.side = $${i}`, filters.side);
  if (filters.timeframe) add((i) => `s.timeframe = $${i}`, filters.timeframe);
  if (filters.status) add((i) => `s.status = $${i}`, filters.status);
  if (filters.symbol) add((i) => `s.symbol ILIKE $${i}`, `%${filters.symbol}%`);
  if (filters.strategy) add((i) => `s.strategy_name ILIKE $${i}`, `%${filters.strategy}%`);
  if (filters.from) add((i) => `s.generated_at >= $${i}::TIMESTAMPTZ`, filters.from);
  if (filters.to) add((i) => `s.generated_at < $${i}::TIMESTAMPTZ`, filters.to);
  if (filters.successful) {
    clauses.push(`EXISTS (
      SELECT 1 FROM public.signal_events success_event
       WHERE success_event.signal_id = s.id
         AND success_event.event_type IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT')
    )`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

export async function listSignalHistory(filters: SignalHistoryFilters) {
  const { where, values } = filterSql(filters);
  const count = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM public.market_signals s ${where}`,
    values,
  );
  const offset = (filters.page - 1) * filters.pageSize;
  const result = await query(
    `SELECT s.id::TEXT AS id, s.scanner_type, s.exchange, s.symbol, s.side, s.timeframe,
            s.strategy_name, s.setup_score, s.entry_price::TEXT AS entry_price,
            s.entry_zone_low::TEXT AS entry_zone_low, s.entry_zone_high::TEXT AS entry_zone_high,
            s.initial_stop::TEXT AS stop_loss, s.tp1::TEXT AS take_profit_1,
            s.tp2::TEXT AS take_profit_2, s.tp3::TEXT AS take_profit_3,
            s.latest_price::TEXT AS current_market_price, s.actual_entry_price::TEXT,
            s.actual_exit_price::TEXT, s.realized_pnl::TEXT, s.simulated_pnl::TEXT,
            s.generated_at, s.entry_expires_at, s.expires_at, s.entry_status, s.status,
            s.closed_at, s.source_metadata,
            COALESCE((
              SELECT jsonb_agg(e.event_type ORDER BY e.event_timestamp, e.id)
                FROM public.signal_events e WHERE e.signal_id = s.id
                 AND e.event_type IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT')
            ), '[]'::JSONB) AS achieved_targets,
            (
              SELECT MIN(e.event_timestamp)
                FROM public.signal_events e
               WHERE e.signal_id = s.id AND e.event_type IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT')
            ) AS first_target_hit_at
       FROM public.market_signals s
       ${where}
      ORDER BY s.generated_at DESC, s.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.pageSize, offset],
  );
  return { items: result.rows, total: Number(count.rows[0]?.total ?? 0), page: filters.page, pageSize: filters.pageSize };
}

export async function getSignalHistoryDetail(signalId: string, userId: number) {
  const [signal, events, research, userEntry] = await Promise.all([
    query(
      `SELECT s.id::TEXT AS id, s.scanner_type, s.exchange, s.symbol, s.side, s.timeframe,
              s.strategy_name, s.setup_score, s.entry_price::TEXT, s.entry_zone_low::TEXT,
              s.entry_zone_high::TEXT, s.initial_stop::TEXT AS stop_loss,
              s.tp1::TEXT AS take_profit_1, s.tp2::TEXT AS take_profit_2,
              s.tp3::TEXT AS take_profit_3, s.latest_price::TEXT AS current_market_price,
              s.actual_entry_price::TEXT, s.actual_exit_price::TEXT,
              s.realized_pnl::TEXT, s.simulated_pnl::TEXT, s.generated_at,
              s.entry_expires_at, s.expires_at, s.entry_status, s.status, s.closed_at,
              s.source_metadata
         FROM public.market_signals s WHERE s.id = $1`,
      [signalId],
    ),
    query(
      `SELECT id::TEXT AS id, event_type, event_price::TEXT AS event_price,
              event_timestamp, payload, metadata
         FROM public.signal_events
        WHERE signal_id = $1 AND (actor_user_id IS NULL OR actor_user_id = $2)
        ORDER BY event_timestamp, id`,
      [signalId, userId],
    ),
    query(
      `SELECT indicator_snapshot, volume_snapshot, market_structure_snapshot,
              derivatives_snapshot, sentiment_snapshot, data_sources, captured_at
         FROM public.signal_research_snapshots WHERE signal_id = $1`,
      [signalId],
    ),
    query(
      `SELECT entry_price::TEXT, exit_price::TEXT, realized_pnl::TEXT, status, entered_at, closed_at
         FROM public.signal_user_entries WHERE signal_id = $1 AND user_id = $2`,
      [signalId, userId],
    ),
  ]);
  if (!signal.rows[0]) return null;
  return {
    signal: signal.rows[0],
    events: events.rows,
    research: research.rows[0] ?? null,
    userEntry: userEntry.rows[0] ?? null,
  };
}

export async function recordUserSignalTrade(
  userId: number,
  signalId: string,
  entryPrice?: string,
  exitPrice?: string,
) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const signal = await client.query<{ id: string; signal_key: string; side: 'LONG' | 'SHORT' }>(
      `SELECT id::TEXT, signal_key, side FROM public.market_signals WHERE id = $1 FOR SHARE`,
      [signalId],
    );
    if (!signal.rowCount) throw new Error('Signal not found.');
    const existing = await client.query<{ entry_price: string | null; status: 'ENTERED' | 'CLOSED' }>(
      `SELECT entry_price::TEXT, status
         FROM public.signal_user_entries
        WHERE user_id = $1 AND signal_id = $2 FOR UPDATE`,
      [userId, signalId],
    );
    if (existing.rows[0]?.status === 'CLOSED') throw new Error('This user-reported trade is already closed and cannot be overwritten.');
    const resolvedEntry = entryPrice ?? existing.rows[0]?.entry_price;
    if (!resolvedEntry) throw new Error('Record an actual entry price before closing the user-reported trade.');
    const isClosed = exitPrice !== undefined;
    const update = await client.query<{ entry_price: string; exit_price: string | null; realized_pnl: string | null }>(
      `INSERT INTO public.signal_user_entries (
         user_id, signal_id, entry_price, exit_price, realized_pnl, status, closed_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         CASE WHEN $5 = 'CLOSED'
              THEN CASE WHEN $6 = 'LONG' THEN $4::NUMERIC - $3::NUMERIC ELSE $3::NUMERIC - $4::NUMERIC END
              ELSE NULL END,
         $5, CASE WHEN $5 = 'CLOSED' THEN NOW() ELSE NULL END, NOW()
       )
       ON CONFLICT (user_id, signal_id) DO UPDATE SET
         entry_price = EXCLUDED.entry_price,
         exit_price = EXCLUDED.exit_price,
         realized_pnl = EXCLUDED.realized_pnl,
         status = EXCLUDED.status,
         closed_at = EXCLUDED.closed_at,
         updated_at = NOW()
       WHERE public.signal_user_entries.status <> 'CLOSED'
       RETURNING entry_price::TEXT, exit_price::TEXT, realized_pnl::TEXT`,
      [userId, signalId, resolvedEntry, exitPrice ?? null, isClosed ? 'CLOSED' : 'ENTERED', signal.rows[0]!.side],
    );
    if (!update.rowCount) throw new Error('This user-reported trade could not be updated.');
    if (entryPrice !== undefined) {
      await client.query(
        `INSERT INTO public.signal_events (
           signal_id, idempotency_key, event_type, payload, event_price,
           event_timestamp, metadata, actor_user_id
         ) VALUES ($1, $2, 'ENTRY_MARKED_AS_ENTERED', $3::JSONB, $4, NOW(), $5::JSONB, $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          signalId,
          `${signal.rows[0]!.signal_key}:USER:${userId}:ENTRY_MARKED_AS_ENTERED`,
          JSON.stringify({ state: 'ENTERED' }),
          resolvedEntry,
          JSON.stringify({ scope: 'per-user', priceSource: 'USER_REPORTED_FILL', tradeExecution: false }),
          userId,
        ],
      );
    }
    if (isClosed) {
      await client.query(
        `INSERT INTO public.signal_events (
           signal_id, idempotency_key, event_type, payload, event_price, event_timestamp, metadata, actor_user_id
         ) VALUES ($1, $2, 'TRADE_CLOSED', $3::JSONB, $4, NOW(), $5::JSONB, $6)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          signalId,
          `${signal.rows[0]!.signal_key}:USER:${userId}:TRADE_CLOSED`,
          JSON.stringify({ result: 'user-reported', realizedPnl: update.rows[0]!.realized_pnl }),
          exitPrice,
          JSON.stringify({ priceSource: 'USER_REPORTED_FILL', tradeExecution: false }),
          userId,
        ],
      );
    }
    await client.query('COMMIT');
    return update.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('User signal trade record rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listUserSignalEntries(userId: number) {
  const result = await query(
    `SELECT e.signal_id::TEXT AS signal_id, s.scanner_type, s.symbol, s.side, s.timeframe,
            s.strategy_name, s.entry_price::TEXT AS reference_entry,
            s.initial_stop::TEXT AS stop_loss, s.tp1::TEXT AS take_profit_1,
            s.tp2::TEXT AS take_profit_2, s.tp3::TEXT AS take_profit_3,
            e.entry_price::TEXT AS actual_entry, e.exit_price::TEXT AS actual_exit,
            e.realized_pnl::TEXT AS realized_pnl, e.status, e.entered_at, e.closed_at,
            s.status AS signal_status
       FROM public.signal_user_entries e
       JOIN public.market_signals s ON s.id = e.signal_id
      WHERE e.user_id = $1
      ORDER BY (e.status = 'ENTERED') DESC, e.entered_at DESC, e.signal_id DESC
      LIMIT 500`,
    [userId],
  );
  return result.rows;
}

const aggregateQuery = `
  WITH event_totals AS (
    SELECT signal_id,
           BOOL_OR(event_type = 'TP1_HIT') AS tp1_hit,
           BOOL_OR(event_type = 'TP2_HIT') AS tp2_hit,
           BOOL_OR(event_type = 'TP3_HIT') AS tp3_hit,
           BOOL_OR(event_type = 'STOP_LOSS_HIT') AS stop_hit
      FROM public.signal_events
     GROUP BY signal_id
  ), user_performance AS (
    SELECT signal_id, AVG(realized_pnl) AS realized_pnl
      FROM public.signal_user_entries
     WHERE status = 'CLOSED'
     GROUP BY signal_id
  )
  SELECT COUNT(*)::TEXT AS total,
         COUNT(*) FILTER (WHERE scanner_type = 'STANDARD')::TEXT AS standard,
         COUNT(*) FILTER (WHERE scanner_type = 'HIGH_RISK')::TEXT AS high_risk,
         COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT'))::TEXT AS active,
         COUNT(*) FILTER (WHERE COALESCE(e.tp1_hit, FALSE))::TEXT AS tp1,
         COUNT(*) FILTER (WHERE COALESCE(e.tp2_hit, FALSE))::TEXT AS tp2,
         COUNT(*) FILTER (WHERE COALESCE(e.tp3_hit, FALSE))::TEXT AS tp3,
         COUNT(*) FILTER (WHERE COALESCE(e.stop_hit, FALSE) OR status = 'STOP_LOSS_HIT')::TEXT AS stop_loss,
         COUNT(*) FILTER (WHERE status = 'EXPIRED')::TEXT AS expired,
         COUNT(*) FILTER (WHERE status = 'MISSED' OR entry_status = 'MISSED')::TEXT AS missed,
         COUNT(*) FILTER (WHERE status = 'ENTRY_INVALIDATED' OR entry_status = 'INVALIDATED')::TEXT AS invalidated,
         ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(e.tp1_hit, FALSE)) / NULLIF(COUNT(*), 0), 2)::TEXT AS tp1_rate,
         ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(e.tp2_hit, FALSE)) / NULLIF(COUNT(*), 0), 2)::TEXT AS tp2_rate,
         ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(e.tp3_hit, FALSE)) / NULLIF(COUNT(*), 0), 2)::TEXT AS tp3_rate,
         ROUND(100.0 * COUNT(*) FILTER (WHERE entry_status = 'ENTERED') / NULLIF(COUNT(*), 0), 2)::TEXT AS entry_success_rate,
         AVG(user_perf.realized_pnl)::TEXT AS average_realized_pnl,
         AVG(perf.simulated_pnl)::TEXT AS average_simulated_pnl,
         AVG(perf.holding_duration_seconds)::TEXT AS average_holding_duration_seconds
    FROM public.market_signals s
    LEFT JOIN event_totals e ON e.signal_id = s.id
    LEFT JOIN user_performance user_perf ON user_perf.signal_id = s.id
    LEFT JOIN public.signal_performance perf ON perf.signal_id = s.id`;

export async function getSignalPerformanceSummary() {
  const [summary, byScanner, byStrategy, byTimeframe, bySymbol] = await Promise.all([
    query(aggregateQuery),
    query(
      `WITH user_performance AS (
         SELECT signal_id, AVG(realized_pnl) AS realized_pnl
           FROM public.signal_user_entries WHERE status = 'CLOSED' GROUP BY signal_id
       )
       SELECT scanner_type, COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE status = 'STOP_LOSS_HIT')::TEXT AS stop_loss,
              COUNT(*) FILTER (WHERE status = 'EXPIRED')::TEXT AS expired,
              COUNT(*) FILTER (WHERE entry_status = 'MISSED')::TEXT AS missed,
              AVG(user_perf.realized_pnl)::TEXT AS average_realized_pnl,
              AVG(perf.simulated_pnl)::TEXT AS average_simulated_pnl
         FROM public.market_signals s
         LEFT JOIN user_performance user_perf ON user_perf.signal_id = s.id
         LEFT JOIN public.signal_performance perf ON perf.signal_id = s.id
        GROUP BY scanner_type ORDER BY scanner_type`,
    ),
    query(
      `SELECT strategy_name, scanner_type, COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE status IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED'))::TEXT AS target_hit
         FROM public.market_signals GROUP BY strategy_name, scanner_type ORDER BY total DESC`,
    ),
    query(
      `SELECT timeframe, scanner_type, COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE status IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED'))::TEXT AS target_hit
         FROM public.market_signals GROUP BY timeframe, scanner_type ORDER BY timeframe, scanner_type`,
    ),
    query(
      `SELECT symbol, scanner_type, COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE status IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED'))::TEXT AS target_hit
         FROM public.market_signals GROUP BY symbol, scanner_type ORDER BY total DESC LIMIT 100`,
    ),
  ]);
  return {
    definitions: {
      targetRates: 'Distinct signals with the specified target event divided by all generated signals; target hits are milestones, not closed trades.',
      entrySuccessRate: 'Signals currently marked ENTERED divided by generated signals. Entries are user-recorded; no orders are executed.',
      winRate: 'Not reported. Expired and missed signals are not treated as losses.',
      averageRealizedPnl: 'Average of user-reported entry and exit fills; not exchange-verified and excludes no fees unless the user accounts for them.',
      averageSimulatedPnl: 'Average only of explicitly recorded simulated terminal outcomes; excludes signals without an outcome.',
    },
    summary: summary.rows[0] ?? {},
    byScanner: byScanner.rows,
    byStrategy: byStrategy.rows,
    byTimeframe: byTimeframe.rows,
    bySymbol: bySymbol.rows,
  };
}

export async function getAdminSignalStats() {
  const [summary, failures, lastWrite, byScanner, duplicates] = await Promise.all([
    query(
      `SELECT COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE generated_at >= CURRENT_DATE)::TEXT AS generated_today,
              COUNT(*) FILTER (WHERE status IN ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'COMPLETED'))::TEXT AS successful_targets,
              COUNT(*) FILTER (WHERE status = 'STOP_LOSS_HIT')::TEXT AS stop_loss,
              COUNT(*) FILTER (WHERE status = 'EXPIRED')::TEXT AS expired,
              COUNT(*) FILTER (WHERE status = 'MISSED')::TEXT AS missed,
              COUNT(*) FILTER (WHERE status = 'ENTRY_INVALIDATED')::TEXT AS invalidated,
              COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT'))::TEXT AS active
         FROM public.market_signals`,
    ),
    query(
      `SELECT COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE resolved_at IS NULL)::TEXT AS unresolved,
              COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '24 hours')::TEXT AS last_24_hours
         FROM public.signal_persistence_failures`,
    ),
    query<{ last_write: string | null }>(
      `SELECT MAX(created_at)::TEXT AS last_write FROM public.signal_events
        WHERE event_type IN ('SIGNAL_GENERATED', 'NEW_SIGNAL')`,
    ),
    query(
      `SELECT scanner_type, COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE generated_at >= CURRENT_DATE)::TEXT AS generated_today,
              COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'TP1_HIT', 'TP2_HIT'))::TEXT AS active
         FROM public.market_signals GROUP BY scanner_type ORDER BY scanner_type`,
    ),
    query<{ count: string }>(
      `SELECT COALESCE(SUM(repeated_scan_count), 0)::TEXT AS count FROM public.market_signals`,
    ),
  ]);
  const pending = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT AS total FROM public.signal_events WHERE processed_at IS NULL`,
  );
  return {
    summary: summary.rows[0] ?? {},
    persistenceFailures: failures.rows[0] ?? {},
    pendingEvents: Number(pending.rows[0]?.total ?? 0),
    duplicatePreventionEvents: Number(duplicates.rows[0]?.count ?? 0),
    lastSuccessfulWrite: lastWrite.rows[0]?.last_write ?? null,
    byScanner: byScanner.rows,
  };
}
