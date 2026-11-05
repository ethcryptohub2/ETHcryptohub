import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

export interface QueryResult<Row extends QueryResultRow = QueryResultRow> {
  rows: Row[];
  rowCount: number;
}

export interface Database {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  transaction<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool, private readonly client?: PoolClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await (this.client ?? this.pool).query<Row>(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(new PostgresDatabase(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}

export function supabasePoolConfig(environment: NodeJS.ProcessEnv = process.env): PoolConfig {
  const host = environment.SUPABASE_DB_HOST?.trim();
  const database = environment.SUPABASE_DB_NAME?.trim();
  const user = environment.SUPABASE_DB_USER?.trim();
  const password = environment.SUPABASE_DB_PASSWORD;
  const port = Number(environment.SUPABASE_DB_PORT ?? 5432);
  const sslMode = (environment.SUPABASE_DB_SSLMODE ?? 'verify-full').trim().toLowerCase();

  if (!host || !database || !user || !password) {
    throw new Error(
      'SUPABASE_DB_HOST, SUPABASE_DB_NAME, SUPABASE_DB_USER, and SUPABASE_DB_PASSWORD must be configured.',
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SUPABASE_DB_PORT must be a valid TCP port.');
  }
  if (!['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    throw new Error('SUPABASE_DB_SSLMODE must require TLS (require, verify-ca, or verify-full).');
  }

  return {
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: 'smartexit-api',
    max: 10,
    connectionTimeoutMillis: 10_000,
  };
}

export function openDatabase(environment: NodeJS.ProcessEnv = process.env): Database {
  const pool = new Pool(supabasePoolConfig(environment));
  return new PostgresDatabase(pool);
}
