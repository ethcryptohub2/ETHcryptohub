import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

const globalForPg = globalThis as typeof globalThis & { ethcryptohubPool?: Pool };

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
      ssl: { rejectUnauthorized: true, servername: url.hostname },
      max: 5,
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
    ssl: { rejectUnauthorized: true, servername: host },
    max: 5,
    connectionTimeoutMillis: 10_000,
    application_name: 'ethcryptohub-next',
  };
}

export function pool(): Pool {
  globalForPg.ethcryptohubPool ??= new Pool(config());
  return globalForPg.ethcryptohubPool;
}

export async function query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
  return pool().query<Row>(sql, [...values]);
}
