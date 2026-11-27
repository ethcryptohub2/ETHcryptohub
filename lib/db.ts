import { X509Certificate } from 'node:crypto';
import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { assertDatabaseAccessAllowed, getUiPreviewFlagStatus } from './ui-preview-mode.mjs';

const DEFAULT_PRODUCTION_SUPABASE_REF = 'kafsdnzzjawikoavkhvm';
const globalForPg = globalThis as typeof globalThis & { ethcryptohubPool?: Pool };

function assertDatabaseAccessEnabled() {
  assertDatabaseAccessAllowed(process.env);
}

function isPlaceholderSecret(value: string | undefined) {
  const trimmed = value?.trim();
  return !trimmed || trimmed === '[SENSITIVE]';
}

function extractDatabaseProjectRef(env: NodeJS.ProcessEnv): string | null {
  const connectionString = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      const directHost = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (directHost) return directHost[1].toLowerCase();
      const user = decodeURIComponent(url.username);
      const poolerUser = /^postgres\.([a-z0-9-]+)$/i.exec(user);
      return poolerUser?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  const host = env.SUPABASE_DB_HOST?.trim() ?? '';
  const directHost = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host);
  if (directHost) return directHost[1].toLowerCase();
  const poolerUser = /^postgres\.([a-z0-9-]+)$/i.exec(env.SUPABASE_DB_USER?.trim() ?? '');
  return poolerUser?.[1]?.toLowerCase() ?? null;
}

export function assertDatabaseTargetIsolation(env: NodeJS.ProcessEnv = process.env) {
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  const deploymentEnv = env.SMARTEXIT_DEPLOYMENT_ENV?.trim().toLowerCase();
  const tradingEnv = (env.SMARTEXIT_TRADING_ENVIRONMENT ?? env.TRADING_ENVIRONMENT)?.trim().toUpperCase();
  const isStagingOrDemo =
    vercelEnv === 'preview' ||
    deploymentEnv === 'staging' ||
    tradingEnv === 'DEMO' ||
    tradingEnv === 'TESTNET';

  if (!isStagingOrDemo) return;

  const productionRef = env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF?.trim().toLowerCase() || DEFAULT_PRODUCTION_SUPABASE_REF;
  const dbRef = extractDatabaseProjectRef(env);
  if (dbRef && dbRef === productionRef) {
    throw new Error('Staging or Demo execution cannot connect to the Production database.');
  }

  const stagingRef = env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF?.trim().toLowerCase();
  if (stagingRef && dbRef && dbRef !== stagingRef) {
    throw new Error(`Database project ref (${dbRef}) does not match configured Staging project (${stagingRef}).`);
  }
}

function validateSslMode(mode: string | undefined) {
  const normalizedMode = mode?.trim().toLowerCase();
  if (normalizedMode && normalizedMode !== 'require' && normalizedMode !== 'verify-full') {
    throw new Error('SUPABASE_DB_SSLMODE must be require or verify-full; certificate verification cannot be disabled.');
  }
}

function certificateAuthority(certificate: string | undefined) {
  if (!certificate) return undefined;
  let value = certificate.trim();
  if (!value || value === '[SENSITIVE]') return undefined;

  if (value.includes('\\n')) {
    value = value.replace(/\\n/g, '\n');
  }

  try {
    if (!new X509Certificate(value).ca) throw new Error();
  } catch {
    throw new Error('SUPABASE_DB_CA_CERT must be a valid PEM-encoded CA certificate.');
  }

  return value;
}

export function databaseSslOptions(
  hostname: string,
  mode = process.env.SUPABASE_DB_SSLMODE,
  caCertificate = process.env.SUPABASE_DB_CA_CERT,
) {
  validateSslMode(mode);
  const ca = certificateAuthority(caCertificate);
  const rejectUnauthorized = process.env.SUPABASE_DB_REJECT_UNAUTHORIZED === 'false' ? false : true;
  return {
    rejectUnauthorized,
    servername: hostname,
    ...(ca ? { ca } : {}),
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
  if (connectionString && !isPlaceholderSecret(connectionString) && !connectionString.includes('[SENSITIVE]')) {
    return true;
  }
  return Boolean(
    process.env.SUPABASE_DB_HOST?.trim() &&
      process.env.SUPABASE_DB_USER?.trim() &&
      !isPlaceholderSecret(process.env.SUPABASE_DB_PASSWORD),
  );
}

function config(): PoolConfig {
  assertDatabaseAccessEnabled();
  assertDatabaseTargetIsolation(process.env);
  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (connectionString) {
    if (isPlaceholderSecret(connectionString) || connectionString.includes('[SENSITIVE]')) {
      throw new Error('Database connection string contains a placeholder or missing credential.');
    }
    const normalized = normalizeDatabaseConnectionString(connectionString);
    return {
      connectionString: normalized.connectionString,
      ssl: databaseSslOptions(normalized.hostname),
      max: Number(process.env.SMARTEXIT_DB_POOL_MAX ?? 2),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'ethcryptohub-next',
    };
  }

  const host = process.env.SUPABASE_DB_HOST?.trim();
  const user = process.env.SUPABASE_DB_USER?.trim();
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!host || !user || isPlaceholderSecret(password)) {
    throw new Error('Configure SUPABASE_DB_URL or SUPABASE_DB_HOST/USER/PASSWORD in the deployment environment.');
  }
  return {
    host,
    port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
    database: process.env.SUPABASE_DB_NAME ?? 'postgres',
    user,
    password,
    ssl: databaseSslOptions(host),
    max: Number(process.env.SMARTEXIT_DB_POOL_MAX ?? 2),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'ethcryptohub-next',
  };
}

export function pool(): Pool {
  assertDatabaseAccessEnabled();
  assertDatabaseTargetIsolation(process.env);
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
