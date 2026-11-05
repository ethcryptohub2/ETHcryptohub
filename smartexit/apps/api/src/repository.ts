import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from './database.js';
import type { CreateTradeInput } from './schemas.js';
import type { RiskSettings, Trade, TradeEvent, TradeStatus } from './types.js';

type Row = QueryResultRow;

function isoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapTrade(row: Row): Trade {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    quoteAsset: String(row.quote_asset),
    side: row.side as Trade['side'],
    status: row.status as TradeStatus,
    entryPrice: Number(row.entry_price),
    quantity: Number(row.quantity),
    initialStop: Number(row.initial_stop),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    trailingPercent: Number(row.trailing_percent),
    trailingActive: row.trailing_active === true || Number(row.trailing_active) === 1,
    trailingStop: row.trailing_stop === null ? null : Number(row.trailing_stop),
    highestPriceSinceTp1: row.highest_price_since_tp1 === null ? null : Number(row.highest_price_since_tp1),
    lowestPriceSinceTp1: row.lowest_price_since_tp1 === null ? null : Number(row.lowest_price_since_tp1),
    currentPrice: Number(row.current_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    realizedPnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    closedAt: row.closed_at === null ? null : isoTimestamp(row.closed_at),
    notes: row.notes === null ? null : String(row.notes),
  };
}

function mapEvent(row: Row): TradeEvent {
  const payload = row.event_payload_json;
  return {
    id: String(row.id),
    tradeId: String(row.trade_id),
    eventKey: String(row.event_key),
    eventType: String(row.event_type),
    eventPayload:
      typeof payload === 'string'
        ? (JSON.parse(payload) as Record<string, unknown>)
        : (payload as Record<string, unknown>),
    createdAt: isoTimestamp(row.created_at),
  };
}

function isOpen(status: TradeStatus): boolean {
  return status === 'OPEN' || status === 'TP1_HIT_TRAILING' || status === 'TP2_HIT_TRAILING';
}

export class TradeRepository {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
  ) {}

  async get(id: string): Promise<Trade | null> {
    const { rows } = await this.db.query('SELECT * FROM trades WHERE id = $1 AND user_id = $2', [id, this.userId]);
    return rows[0] ? mapTrade(rows[0]) : null;
  }

  async list(limit = 100, offset = 0): Promise<Trade[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [this.userId, limit, offset],
    );
    return rows.map(mapTrade);
  }

  async listOpen(): Promise<Trade[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM trades WHERE user_id = $1
       AND status IN ('OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING') ORDER BY created_at DESC`,
      [this.userId],
    );
    return rows.map(mapTrade);
  }

  async insert(input: CreateTradeInput): Promise<Trade> {
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      await tx.query(
        `INSERT INTO trades (
          id, user_id, symbol, quote_asset, side, status, entry_price, quantity, initial_stop, tp1, tp2, tp3,
          trailing_percent, current_price, created_at, updated_at, notes
        ) VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9, $10, $11, $12, $6, $13, $13, $14)`,
        [
          id,
          this.userId,
          input.symbol.toUpperCase(),
          input.quoteAsset.toUpperCase(),
          input.side,
          input.entryPrice,
          input.quantity,
          input.initialStop,
          input.tp1,
          input.tp2,
          input.tp3,
          input.trailingPercent,
          now,
          input.notes ?? null,
        ],
      );
      await this.insertEvent(
        tx,
        id,
        `trade-created:${id}`,
        'TRADE_CREATED',
        { side: input.side, entryPrice: input.entryPrice, quantity: input.quantity, mode: 'PAPER' },
        now,
      );
      const { rows } = await tx.query('SELECT * FROM trades WHERE id = $1 AND user_id = $2', [id, this.userId]);
      return mapTrade(rows[0]!);
    });
  }

  async updatePrice(
    id: string,
    eventId: string,
    price: number,
    recordTick = true,
    usdtPerQuoteUnit: number | null = 1,
  ): Promise<{ trade: Trade; duplicate: boolean }> {
    return this.db.transaction(async (tx) => {
      const { rows: trades } = await tx.query(
        'SELECT * FROM trades WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, this.userId],
      );
      if (!trades[0]) throw new RepositoryError(404, 'Trade not found.');
      const trade = mapTrade(trades[0]);
      const { rows: prior } = await tx.query('SELECT trade_id FROM trade_events WHERE event_key = $1', [eventId]);
      if (prior[0]) {
        if (prior[0].trade_id !== id)
          throw new RepositoryError(409, 'This event ID was already used for another trade.');
        return { trade, duplicate: true };
      }
      if (!isOpen(trade.status))
        throw new RepositoryError(409, 'This trade is closed and cannot be updated.');

      const now = new Date().toISOString();
      const transition = applyPrice(trade, price, now, recordTick);
      const updated = transition.trade;
      await tx.query(
        `UPDATE trades SET status = $1, trailing_active = $2, trailing_stop = $3,
          highest_price_since_tp1 = $4, lowest_price_since_tp1 = $5, current_price = $6,
          exit_price = $7, realized_pnl = $8, updated_at = $9, closed_at = $10
         WHERE id = $11 AND user_id = $12`,
        [
          updated.status,
          updated.trailingActive,
          updated.trailingStop,
          updated.highestPriceSinceTp1,
          updated.lowestPriceSinceTp1,
          updated.currentPrice,
          updated.exitPrice,
          updated.realizedPnl,
          now,
          updated.closedAt,
          id,
          this.userId,
        ],
      );
      for (const event of transition.events) {
        await this.insertEvent(tx, id, eventId, event.type, event.payload, now, event.index);
      }
      if (updated.realizedPnl !== null) {
        await this.recordRealizedPnl(tx, updated.realizedPnl, trade.quoteAsset, usdtPerQuoteUnit, now);
      }
      const { rows } = await tx.query('SELECT * FROM trades WHERE id = $1 AND user_id = $2', [id, this.userId]);
      return { trade: mapTrade(rows[0]!), duplicate: false };
    });
  }

  async cancel(id: string, usdtPerQuoteUnit: number | null = 1): Promise<Trade> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query('SELECT * FROM trades WHERE id = $1 AND user_id = $2 FOR UPDATE', [
        id,
        this.userId,
      ]);
      if (!rows[0]) throw new RepositoryError(404, 'Trade not found.');
      const trade = mapTrade(rows[0]);
      if (!isOpen(trade.status)) throw new RepositoryError(409, 'This trade is already closed.');
      const now = new Date().toISOString();
      const realizedPnl =
        (trade.side === 'LONG'
          ? trade.currentPrice - trade.entryPrice
          : trade.entryPrice - trade.currentPrice) * trade.quantity;
      await tx.query(
        `UPDATE trades SET status = 'CANCELLED', exit_price = $1, realized_pnl = $2,
         updated_at = $3, closed_at = $3 WHERE id = $4 AND user_id = $5`,
        [trade.currentPrice, realizedPnl, now, id, this.userId],
      );
      await this.insertEvent(
        tx,
        id,
        `trade-cancelled:${randomUUID()}`,
        'TRADE_CANCELLED',
        { price: trade.currentPrice, quantityClosed: trade.quantity, realizedPnl, mode: 'PAPER' },
        now,
      );
      await this.recordRealizedPnl(tx, realizedPnl, trade.quoteAsset, usdtPerQuoteUnit, now);
      const { rows: updated } = await tx.query('SELECT * FROM trades WHERE id = $1 AND user_id = $2', [
        id,
        this.userId,
      ]);
      return mapTrade(updated[0]!);
    });
  }

  async getEvents(limit = 100, offset = 0, tradeId?: string): Promise<TradeEvent[]> {
    const query = tradeId
      ? `SELECT e.* FROM trade_events e JOIN trades t ON t.id = e.trade_id
         WHERE t.user_id = $1 AND e.trade_id = $2 ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`
      : `SELECT e.* FROM trade_events e JOIN trades t ON t.id = e.trade_id
         WHERE t.user_id = $1 ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`;
    const values = tradeId
      ? [this.userId, tradeId, limit, offset]
      : [this.userId, limit, offset];
    const { rows } = await this.db.query(query, values);
    return rows.map(mapEvent);
  }

  private async insertEvent(
    db: Database,
    tradeId: string,
    eventKey: string,
    type: string,
    payload: Record<string, unknown>,
    now: string,
    index = 0,
  ): Promise<void> {
    const uniqueKey = index === 0 ? eventKey : `${eventKey}:${index}`;
    await db.query(
      `INSERT INTO trade_events (id, trade_id, event_key, event_type, event_payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), tradeId, uniqueKey, type, JSON.stringify(payload), now],
    );
  }

  private async recordRealizedPnl(
    db: Database,
    pnl: number,
    asset: string,
    usdtPerQuoteUnit: number | null,
    now: string,
  ): Promise<void> {
    const day = now.slice(0, 10);
    const settings = await getRiskSettings(db, this.userId);
    await db.query(
      `INSERT INTO paper_asset_balances (user_id, asset) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [this.userId, asset],
    );
    await db.query(
      'UPDATE paper_asset_balances SET realized_pnl = realized_pnl + $1 WHERE user_id = $2 AND asset = $3',
      [pnl, this.userId, asset],
    );
    if (usdtPerQuoteUnit === null) return;
    const pnlInUsdt = pnl * usdtPerQuoteUnit;
    await db.query('UPDATE paper_users SET realized_pnl = realized_pnl + $1 WHERE id = $2', [
      pnlInUsdt,
      this.userId,
    ]);
    await db.query(
      `INSERT INTO daily_stats (user_id, day_utc, asset, starting_equity)
       VALUES ($1, $2, 'USDT', $3) ON CONFLICT DO NOTHING`,
      [this.userId, day, settings.paperEquity],
    );
    await db.query(
      `UPDATE daily_stats SET realized_pnl = realized_pnl + $1
       WHERE user_id = $2 AND day_utc = $3 AND asset = 'USDT'`,
      [pnlInUsdt, this.userId, day],
    );
    const { rows } = await db.query(
      `SELECT starting_equity, realized_pnl FROM daily_stats
       WHERE user_id = $1 AND day_utc = $2 AND asset = 'USDT'`,
      [this.userId, day],
    );
    const stats = rows[0]!;
    if (Number(stats.realized_pnl) <= -(Number(stats.starting_equity) * settings.maxDailyLossPercent) / 100) {
      await db.query(
        `UPDATE daily_stats SET new_trades_blocked = TRUE
         WHERE user_id = $1 AND day_utc = $2 AND asset = 'USDT'`,
        [this.userId, day],
      );
    }
  }
}

export class RiskRepository {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
  ) {}

  get(): Promise<RiskSettings> {
    return getRiskSettings(this.db, this.userId);
  }

  async update(settings: Omit<RiskSettings, 'updatedAt'>): Promise<RiskSettings> {
    await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.query(
        `UPDATE risk_settings SET paper_equity = $1, max_open_positions = $2,
         max_risk_per_trade_percent = $3, max_daily_loss_percent = $4,
         kill_switch_enabled = $5, updated_at = $6 WHERE user_id = $7`,
        [
          settings.paperEquity,
          settings.maxOpenPositions,
          settings.maxRiskPerTradePercent,
          settings.maxDailyLossPercent,
          settings.killSwitchEnabled,
          now,
          this.userId,
        ],
      );
      await tx.query('UPDATE paper_users SET starting_balance = $1 WHERE id = $2', [
        settings.paperEquity,
        this.userId,
      ]);
      await tx.query(
        `INSERT INTO paper_asset_balances (user_id, asset, starting_balance, realized_pnl)
         VALUES ($1, 'USDT', $2, 0)
         ON CONFLICT (user_id, asset) DO UPDATE SET starting_balance = EXCLUDED.starting_balance`,
        [this.userId, settings.paperEquity],
      );
    });
    return this.get();
  }

  async setKillSwitch(enabled: boolean): Promise<RiskSettings> {
    await this.db.query('UPDATE risk_settings SET kill_switch_enabled = $1, updated_at = $2 WHERE user_id = $3', [
      enabled,
      new Date().toISOString(),
      this.userId,
    ]);
    return this.get();
  }

  async openPositionCount(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT COUNT(*) AS count FROM trades WHERE user_id = $1
       AND status IN ('OPEN', 'TP1_HIT_TRAILING', 'TP2_HIT_TRAILING')`,
      [this.userId],
    );
    return Number(rows[0]!.count);
  }

  async dailyRisk(): Promise<{
    dayUtc: string;
    startingEquity: number;
    realizedPnl: number;
    lossLimit: number;
    blocked: boolean;
  }> {
    const day = new Date().toISOString().slice(0, 10);
    const settings = await this.get();
    await this.db.query(
      `INSERT INTO daily_stats (user_id, day_utc, asset, starting_equity)
       VALUES ($1, $2, 'USDT', $3) ON CONFLICT DO NOTHING`,
      [this.userId, day, settings.paperEquity],
    );
    const { rows } = await this.db.query(
      `SELECT starting_equity, realized_pnl, new_trades_blocked FROM daily_stats
       WHERE user_id = $1 AND day_utc = $2 AND asset = 'USDT'`,
      [this.userId, day],
    );
    const row = rows[0]!;
    const startingEquity = Number(row.starting_equity);
    const realizedPnl = Number(row.realized_pnl);
    const lossLimit = (startingEquity * settings.maxDailyLossPercent) / 100;
    const blocked = row.new_trades_blocked === true || Number(row.new_trades_blocked) === 1 || realizedPnl <= -lossLimit;
    return { dayUtc: day, startingEquity, realizedPnl, lossLimit, blocked };
  }
}

export class RepositoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface TransitionEvent {
  type: string;
  payload: Record<string, unknown>;
  index: number;
}

function applyPrice(
  trade: Trade,
  price: number,
  now: string,
  recordTick: boolean,
): { trade: Trade; events: TransitionEvent[] } {
  const next = { ...trade, currentPrice: price, updatedAt: now };
  const events: TransitionEvent[] = [];
  const addEvent = (type: string, payload: Record<string, unknown>): void => {
    events.push({ type, payload, index: events.length });
  };
  const long = trade.side === 'LONG';
  const stopHit = next.trailingActive
    ? long
      ? price <= (next.trailingStop ?? Number.POSITIVE_INFINITY)
      : price >= (next.trailingStop ?? Number.NEGATIVE_INFINITY)
    : long
      ? price <= next.initialStop
      : price >= next.initialStop;

  if (stopHit) {
    next.status = next.trailingActive ? 'STOPPED_TRAILING_SL' : 'STOPPED_INITIAL_SL';
    next.exitPrice = price;
    next.realizedPnl = (long ? price - next.entryPrice : next.entryPrice - price) * next.quantity;
    next.closedAt = now;
    addEvent(next.status, { price, quantityClosed: next.quantity, realizedPnl: next.realizedPnl });
    return { trade: next, events };
  }

  const crossed = (target: number): boolean => (long ? price >= target : price <= target);
  if (!next.trailingActive && crossed(next.tp1)) {
    next.trailingActive = true;
    next.status = 'TP1_HIT_TRAILING';
    next.highestPriceSinceTp1 = long ? price : null;
    next.lowestPriceSinceTp1 = long ? null : price;
    next.trailingStop = long
      ? price * (1 - next.trailingPercent / 100)
      : price * (1 + next.trailingPercent / 100);
    addEvent('TP1_HIT_TRAILING', { price, quantityRetained: next.quantity, trailingStop: next.trailingStop });
  }

  if (next.trailingActive) {
    if (long) {
      next.highestPriceSinceTp1 = Math.max(next.highestPriceSinceTp1 ?? price, price);
      next.trailingStop = Math.max(
        next.trailingStop ?? 0,
        next.highestPriceSinceTp1 * (1 - next.trailingPercent / 100),
      );
    } else {
      next.lowestPriceSinceTp1 = Math.min(next.lowestPriceSinceTp1 ?? price, price);
      next.trailingStop = Math.min(
        next.trailingStop ?? Number.POSITIVE_INFINITY,
        next.lowestPriceSinceTp1 * (1 + next.trailingPercent / 100),
      );
    }
  }

  if (next.status === 'TP1_HIT_TRAILING' && crossed(next.tp2)) {
    next.status = 'TP2_HIT_TRAILING';
    addEvent('TP2_HIT_TRAILING', { price, quantityRetained: next.quantity });
  } else if (next.status === 'OPEN' && crossed(next.tp2)) {
    next.status = 'TP2_HIT_TRAILING';
    next.trailingActive = true;
    next.highestPriceSinceTp1 = long ? price : null;
    next.lowestPriceSinceTp1 = long ? null : price;
    next.trailingStop = long
      ? price * (1 - next.trailingPercent / 100)
      : price * (1 + next.trailingPercent / 100);
    addEvent('TP1_HIT_TRAILING', { price, quantityRetained: next.quantity, trailingStop: next.trailingStop });
    addEvent('TP2_HIT_TRAILING', { price, quantityRetained: next.quantity });
  }

  if (crossed(next.tp3)) {
    next.status = 'COMPLETED_TP3';
    next.exitPrice = price;
    next.realizedPnl = (long ? price - next.entryPrice : next.entryPrice - price) * next.quantity;
    next.closedAt = now;
    addEvent('COMPLETED_TP3', { price, quantityClosed: next.quantity, realizedPnl: next.realizedPnl });
  }

  if (recordTick && (events.length === 0 || events[events.length - 1]?.type !== 'COMPLETED_TP3')) {
    addEvent('PRICE_UPDATED', { price });
  }
  return { trade: next, events };
}

async function getRiskSettings(db: Database, userId: string): Promise<RiskSettings> {
  const { rows } = await db.query('SELECT * FROM risk_settings WHERE user_id = $1', [userId]);
  const row = rows[0];
  if (!row) throw new RepositoryError(404, 'Risk settings not found.');
  return {
    paperEquity: Number(row.paper_equity),
    maxOpenPositions: Number(row.max_open_positions),
    maxRiskPerTradePercent: Number(row.max_risk_per_trade_percent),
    maxDailyLossPercent: Number(row.max_daily_loss_percent),
    killSwitchEnabled: row.kill_switch_enabled === true || Number(row.kill_switch_enabled) === 1,
    updatedAt: isoTimestamp(row.updated_at),
  };
}
