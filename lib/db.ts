import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

const globalForPg = globalThis as typeof globalThis & { ethcryptohubPool?: Pool };

const migrationFilesByTable = new Map<string, string>([
  ['public.market_research_credentials', 'supabase/migrations/202611060001_market_research.sql'],
  ['public.market_signals', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.signal_events', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.user_notification_preferences', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.push_subscriptions', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.user_signal_notifications', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.push_delivery_attempts', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.notification_system_settings', 'supabase/migrations/202611060002_signal_notifications.sql'],
  ['public.scanner_coin_configs', 'supabase/migrations/202611060003_scanner_coin_management.sql'],
  ['public.scanner_sync_state', 'supabase/migrations/202611060003_scanner_coin_management.sql'],
  ['public.scanner_coin_audit_log', 'supabase/migrations/202611060003_scanner_coin_management.sql'],
  ['public.scanner_admin_rate_limits', 'supabase/migrations/202611060003_scanner_coin_management.sql'],
  ['public.scanner_candidate_snapshots', 'supabase/migrations/202611060003_scanner_coin_management.sql'],
  ['public.subscription_plans', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.subscriptions', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.license_codes', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.subscription_transactions', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.subscription_audit_log', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.subscription_activation_attempts', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.subscription_admin_rate_limits', 'supabase/migrations/202611060004_subscriptions.sql'],
  ['public.high_risk_scalping_settings', 'supabase/migrations/202611070001_high_risk_scalping.sql'],
  ['public.high_risk_scalping_signals', 'supabase/migrations/202611070001_high_risk_scalping.sql'],
  ['public.high_risk_scalping_user_states', 'supabase/migrations/202611070001_high_risk_scalping.sql'],
  ['public.high_risk_scalping_preferences', 'supabase/migrations/202611070001_high_risk_scalping.sql'],
  ['public.high_risk_scalping_notifications', 'supabase/migrations/202611070001_high_risk_scalping.sql'],
  ['public.signal_research_snapshots', 'supabase/migrations/202611070002_signal_history_performance.sql'],
  ['public.signal_performance', 'supabase/migrations/202611070002_signal_history_performance.sql'],
  ['public.signal_user_entries', 'supabase/migrations/202611070002_signal_history_performance.sql'],
  ['public.signal_persistence_failures', 'supabase/migrations/202611070002_signal_history_performance.sql'],
  ['public.news_categories', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.news_sources', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.news_articles', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.news_processing_logs', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.news_user_preferences', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.news_notifications', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.platform_settings', 'supabase/migrations/202611070003_news_platform.sql'],
  ['public.user_trading_settings', 'supabase/migrations/202611100001_live_futures_trading.sql'],
  ['public.trade_executions', 'supabase/migrations/202611100001_live_futures_trading.sql'],
]);
const migrationRuns = new Map<string, Promise<void>>();

function sslOptions(hostname: string) {
  const mode = process.env.SUPABASE_DB_SSLMODE?.trim().toLowerCase();
  return {
    rejectUnauthorized: mode !== 'require',
    servername: hostname,
  };
}

export function isDatabaseConfigured() {
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  return Boolean(
    connectionString ||
      (process.env.SUPABASE_DB_HOST?.trim() &&
        process.env.SUPABASE_DB_USER?.trim() &&
        process.env.SUPABASE_DB_PASSWORD),
  );
}

function config(): PoolConfig {
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Database URL must use PostgreSQL.');
    return {
      connectionString,
      ssl: sslOptions(url.hostname),
      max: 1,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'ethcryptohub-next',
    };
  }

  const host = process.env.SUPABASE_DB_HOST?.trim();
  const user = process.env.SUPABASE_DB_USER?.trim();
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!host || !user || !password) {
    throw new Error('Configure SUPABASE_DB_URL or SUPABASE_DB_HOST/USER/PASSWORD in the deployment environment.');
  }
  return {
    host,
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    database: process.env.SUPABASE_DB_NAME ?? 'postgres',
    user,
    password,
    ssl: sslOptions(host),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'ethcryptohub-next',
  };
}

export function pool(): Pool {
  globalForPg.ethcryptohubPool ??= new Pool(config());
  return globalForPg.ethcryptohubPool;
}

function missingTableFromError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  const match = /(?:relation|table)\s+"?(?:public\.)?([A-Za-z0-9_]+)"?\s+does not exist/i.exec(message);
  if (!match) return null;
  return `public.${match[1]}`;
}

async function executeMigration(relativePath: string, tableName: string): Promise<void> {
  const sqlFile = path.join(process.cwd(), 'supabase', 'migrations', path.basename(relativePath));
  const sql = await fs.readFile(sqlFile, 'utf8');
  const client = await pool().connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [relativePath]);
    lockAcquired = true;
    const existing = await client.query<{ table_exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS table_exists',
      [tableName],
    );
    if (existing.rows[0]?.table_exists) return;

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database migration rollback failed:', rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error');
      }
      throw error;
    }
  } catch (error) {
    console.error(`Automatic database migration failed for ${tableName}:`, error instanceof Error ? error.message : 'Unknown migration error');
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [relativePath]);
      } catch (error) {
        console.error('Database migration lock release failed:', error instanceof Error ? error.message : 'Unknown lock error');
      }
    }
    client.release();
  }
}

async function applyMigrationForTable(tableName: string): Promise<boolean> {
  const relativePath = migrationFilesByTable.get(tableName);
  if (!relativePath) return false;
  let migration = migrationRuns.get(relativePath);
  if (!migration) {
    migration = executeMigration(relativePath, tableName);
    migrationRuns.set(relativePath, migration);
  }
  try {
    await migration;
    return true;
  } finally {
    if (migrationRuns.get(relativePath) === migration) migrationRuns.delete(relativePath);
  }
}

export async function query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
  try {
    return await pool().query<Row>(sql, [...values]);
  } catch (error) {
    const missingTable = missingTableFromError(error);
    if (!missingTable) throw error;
    if (!(await applyMigrationForTable(missingTable))) throw error;
    return pool().query<Row>(sql, [...values]);
  }
}

function isRetryableDatabaseError(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String(error.code);
  return code.startsWith('08') || ['40001', '40P01', '53300', '57P01', '57P02', '57P03'].includes(code);
}

export async function retryDatabaseWrite<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryableDatabaseError(error)) throw error;
      const delayMs = 150 * (2 ** attempt);
      console.error(`Transient database write failure; retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries}).`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function recordSignalPersistenceFailure(
  scannerType: 'STANDARD' | 'HIGH_RISK',
  source: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : 'Unknown signal persistence failure.';
  try {
    await query(
      `INSERT INTO public.signal_persistence_failures (scanner_type, source, error_message)
       VALUES ($1, $2, $3)`,
      [scannerType, source, message.slice(0, 4000)],
    );
  } catch (loggingError) {
    console.error(
      `Signal persistence failure could not be recorded in the database (${scannerType}/${source}):`,
      loggingError instanceof Error ? loggingError.message : 'Unknown logging error.',
    );
  }
}
