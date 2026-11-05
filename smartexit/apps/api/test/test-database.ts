import { DatabaseSync } from 'node:sqlite';
import type { Database, QueryResult } from '../src/database.js';

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE paper_users (
    id TEXT PRIMARY KEY, near_account_id TEXT NOT NULL UNIQUE,
    starting_balance REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE paper_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES paper_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY, nonce BLOB NOT NULL, message TEXT NOT NULL,
    recipient TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE trades (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES paper_users(id), symbol TEXT NOT NULL,
    quote_asset TEXT NOT NULL DEFAULT 'USDT', side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    status TEXT NOT NULL, entry_price REAL NOT NULL, quantity REAL NOT NULL, initial_stop REAL NOT NULL,
    tp1 REAL NOT NULL, tp2 REAL NOT NULL, tp3 REAL NOT NULL, trailing_percent REAL NOT NULL,
    trailing_active INTEGER NOT NULL DEFAULT 0, trailing_stop REAL, highest_price_since_tp1 REAL,
    lowest_price_since_tp1 REAL, current_price REAL NOT NULL, exit_price REAL, realized_pnl REAL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, notes TEXT
  );
  CREATE TABLE trade_events (
    id TEXT PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, event_payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE risk_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE REFERENCES paper_users(id) ON DELETE CASCADE,
    paper_equity REAL NOT NULL, max_open_positions INTEGER NOT NULL,
    max_risk_per_trade_percent REAL NOT NULL, max_daily_loss_percent REAL NOT NULL,
    kill_switch_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
  CREATE TABLE daily_stats (
    user_id TEXT NOT NULL REFERENCES paper_users(id) ON DELETE CASCADE,
    day_utc TEXT NOT NULL, asset TEXT NOT NULL DEFAULT 'USDT', starting_equity REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0, new_trades_blocked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day_utc, asset)
  );
  CREATE TABLE paper_asset_balances (
    user_id TEXT NOT NULL REFERENCES paper_users(id) ON DELETE CASCADE, asset TEXT NOT NULL,
    starting_balance REAL NOT NULL DEFAULT 0, realized_pnl REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, asset)
  );
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX idx_trade_events_created ON trade_events(created_at DESC);
  CREATE INDEX idx_trade_events_trade ON trade_events(trade_id, created_at);
  CREATE INDEX idx_trades_user_created ON trades(user_id, created_at DESC);
  CREATE INDEX idx_sessions_expiry ON paper_sessions(expires_at);
  CREATE INDEX idx_challenges_expiry ON auth_challenges(expires_at);
  CREATE INDEX idx_daily_stats_user_day ON daily_stats(user_id, day_utc DESC);
`;

export class SqliteTestDatabase implements Database {
  constructor(private readonly sqlite: DatabaseSync) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const expandedValues: unknown[] = [];
    const sql = text.replace(/\s+FOR UPDATE\b/gi, '').replace(/\$(\d+)/g, (_match, index: string) => {
      expandedValues.push(values[Number(index) - 1]);
      return '?';
    });
    const statement = this.sqlite.prepare(sql);
    const bindings = expandedValues.map((value) => (typeof value === 'boolean' ? Number(value) : value)) as (
      | string
      | number
      | bigint
      | null
      | Uint8Array
    )[];
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
      return { rows: statement.all(...bindings) as Row[], rowCount: 0 };
    }
    const result = statement.run(...bindings);
    return { rows: [], rowCount: Number(result.changes) };
  }

  prepare(query: string) {
    return this.sqlite.prepare(query);
  }

  async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(this);
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.sqlite.close();
  }
}

export function openTestDatabase(): SqliteTestDatabase {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  return new SqliteTestDatabase(sqlite);
}
