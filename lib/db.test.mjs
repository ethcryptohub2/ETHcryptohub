import assert from 'node:assert/strict';
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

const { query } = await import('./db.ts');

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
