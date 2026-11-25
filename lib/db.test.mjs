import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import test from 'node:test';

const calls = [];
const missingTableError = Object.assign(
  new Error('relation "public.market_signals" does not exist'),
  { code: '42P01' },
);

globalThis.ethcryptohubPool = {
  query: async (sql, values) => {
    calls.push({ sql, values });
    throw missingTableError;
  },
};

const { assertDatabaseTargetIsolation, databaseSslOptions, normalizeDatabaseConnectionString, query } = await import('./db.ts');

test('Preview and Production module initialization does not issue schema queries', async () => {
  for (const environment of ['preview', 'production']) {
    process.env.VERCEL_ENV = environment;
    await import(`./db.ts?startup=${environment}`);
    assert.deepEqual(calls, []);
  }
});

test('Preview and Production missing-table errors fail without applying schema', async () => {
  const sql = 'SELECT * FROM public.market_signals WHERE id = $1';
  const values = [7];

  for (const environment of ['preview', 'production']) {
    process.env.VERCEL_ENV = environment;
    calls.length = 0;

    await assert.rejects(query(sql, values), (error) => error === missingTableError);
    assert.deepEqual(calls, [{ sql, values }]);
  }
});

test('database TLS verifies certificates and hostnames for secure SSL modes', () => {
  assert.deepEqual(databaseSslOptions('db.staging.supabase.co', 'require'), {
    rejectUnauthorized: true,
    servername: 'db.staging.supabase.co',
  });
  assert.deepEqual(databaseSslOptions('db.staging.supabase.co', 'verify-full'), {
    rejectUnauthorized: true,
    servername: 'db.staging.supabase.co',
  });
  assert.throws(() => databaseSslOptions('db.staging.supabase.co', 'no-verify'), /certificate verification cannot be disabled/);
});

test('database TLS can trust an additional CA without disabling verification', () => {
  const ca = rootCertificates.find((certificate) => new X509Certificate(certificate).ca);
  assert.ok(ca);
  assert.deepEqual(databaseSslOptions('db.staging.supabase.co', 'verify-full', ca), {
    rejectUnauthorized: true,
    servername: 'db.staging.supabase.co',
    ca,
  });

  const escapedCa = ca.replace(/\r?\n/g, '\\n');
  assert.deepEqual(databaseSslOptions('db.staging.supabase.co', 'verify-full', escapedCa), {
    rejectUnauthorized: true,
    servername: 'db.staging.supabase.co',
    ca: escapedCa.replace(/\\n/g, '\n'),
  });
});

test('database TLS rejects invalid or non-CA certificate overrides', () => {
  assert.throws(
    () => databaseSslOptions('db.staging.supabase.co', 'verify-full', 'not a certificate'),
    /SUPABASE_DB_CA_CERT must be a valid PEM-encoded CA certificate/,
  );
});

test('database URLs cannot override strict TLS with an insecure sslmode', () => {
  const normalized = normalizeDatabaseConnectionString(
    'postgresql://staging:secret@db.staging.supabase.co/postgres?sslmode=require',
    'verify-full',
  );
  assert.equal(normalized.hostname, 'db.staging.supabase.co');
  assert.equal(new URL(normalized.connectionString).searchParams.has('sslmode'), false);
  assert.throws(
    () => normalizeDatabaseConnectionString('postgresql://staging:secret@db.staging.supabase.co/postgres?sslmode=no-verify'),
    /certificate verification cannot be disabled/,
  );
});

test('database client fails closed on placeholder credentials and blocks Production targets in Staging/Demo', async () => {
  const originalPool = globalThis.ethcryptohubPool;
  const saved = {
    url: process.env.SUPABASE_DB_URL,
    dbUrl: process.env.DATABASE_URL,
    host: process.env.SUPABASE_DB_HOST,
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    deployEnv: process.env.SMARTEXIT_DEPLOYMENT_ENV,
    prodRef: process.env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF,
    stagingRef: process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF,
    vercelEnv: process.env.VERCEL_ENV,
  };
  try {
    delete globalThis.ethcryptohubPool;
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    process.env.SUPABASE_DB_HOST = 'aws-0-ap-southeast-2.pooler.supabase.com';
    process.env.SUPABASE_DB_USER = 'postgres.ghecpkpaxbrvehquhzkr';
    process.env.SUPABASE_DB_PASSWORD = '[SENSITIVE]';
    process.env.SMARTEXIT_DEPLOYMENT_ENV = 'staging';
    process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF = 'ghecpkpaxbrvehquhzkr';
    process.env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF = 'kafsdnzzjawikoavkhvm';

    await assert.rejects(query('SELECT 1'), /Configure SUPABASE_DB_URL or SUPABASE_DB_HOST\/USER\/PASSWORD/);

    assert.throws(
      () => assertDatabaseTargetIsolation({
        SMARTEXIT_DEPLOYMENT_ENV: 'staging',
        SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF: 'kafsdnzzjawikoavkhvm',
        SUPABASE_DB_USER: 'postgres.kafsdnzzjawikoavkhvm',
      }),
      /cannot connect to the Production database/,
    );
    assert.throws(
      () => assertDatabaseTargetIsolation({
        TRADING_ENVIRONMENT: 'DEMO',
        SMARTEXIT_STAGING_SUPABASE_PROJECT_REF: 'ghecpkpaxbrvehquhzkr',
        SUPABASE_DB_USER: 'postgres.otherprojectref',
      }),
      /does not match configured Staging project/,
    );
  } finally {
    globalThis.ethcryptohubPool = originalPool;
    for (const [k, key] of [
      ['url', 'SUPABASE_DB_URL'],
      ['dbUrl', 'DATABASE_URL'],
      ['host', 'SUPABASE_DB_HOST'],
      ['user', 'SUPABASE_DB_USER'],
      ['password', 'SUPABASE_DB_PASSWORD'],
      ['deployEnv', 'SMARTEXIT_DEPLOYMENT_ENV'],
      ['prodRef', 'SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF'],
      ['stagingRef', 'SMARTEXIT_STAGING_SUPABASE_PROJECT_REF'],
      ['vercelEnv', 'VERCEL_ENV'],
    ]) {
      if (saved[k] === undefined) delete process.env[key];
      else process.env[key] = saved[k];
    }
  }
});
