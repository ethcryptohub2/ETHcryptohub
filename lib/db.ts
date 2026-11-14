import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { assertDatabaseAccessAllowed, getUiPreviewFlagStatus } from './ui-preview-mode.mjs';

const globalForPg = globalThis as typeof globalThis & { ethcryptohubPool?: Pool };

function assertDatabaseAccessEnabled() {
  assertDatabaseAccessAllowed(process.env);
}

function validateSslMode(mode: string | undefined) {
  const normalizedMode = mode?.trim().toLowerCase();
  if (normalizedMode && normalizedMode !== 'require' && normalizedMode !== 'verify-full') {
    throw new Error('SUPABASE_DB_SSLMODE must be require or verify-full; certificate verification cannot be disabled.');
  }
}

export function databaseSslOptions(hostname: string, mode = process.env.SUPABASE_DB_SSLMODE) {
  validateSslMode(mode);
  return {
    rejectUnauthorized: true,
    servername: hostname,
  };
}

export function normalizeDatabaseConnectionString(
  connectionString: string,
  mode = process.env.SUPABASE_DB_SSLMODE,
) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Database URL must use PostgreSQL.');
  }
  validateSslMode(mode);
  validateSslMode(url.searchParams.get('sslmode') ?? undefined);
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), hostname: url.hostname };
}

export function isDatabaseConfigured() {
  if (getUiPreviewFlagStatus(process.env) !== 'disabled') return false;
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  return Boolean(
    connectionString ||
      (process.env.SUPABASE_DB_HOST?.trim() &&
        process.env.SUPABASE_DB_USER?.trim() &&
        process.env.SUPABASE_DB_PASSWORD),
  );
}

function config(): PoolConfig {
  assertDatabaseAccessEnabled();
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (connectionString) {
    const normalized = normalizeDatabaseConnectionString(connectionString);
    return {
      connectionString: normalized.connectionString,
      ssl: databaseSslOptions(normalized.hostname),
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
    ssl: databaseSslOptions(host),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'ethcryptohub-next',
  };
}

export function pool(): Pool {
  assertDatabaseAccessEnabled();
  globalForPg.ethcryptohubPool ??= new Pool(config());
  return globalForPg.ethcryptohubPool;
}

export async function query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
  return pool().query<Row>(sql, [...values]);
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
