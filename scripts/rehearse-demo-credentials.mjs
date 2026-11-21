import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import pg from 'pg';
import ts from 'typescript';

if (process.argv.length !== 3 || process.argv[2] !== '--disposable-loopback') {
  throw new Error('Requires the isolated scanner_fixture database on loopback port 53104.');
}

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'server-only' ? {} : originalLoad.call(this, request, parent, isMain);
};
Module._extensions['.ts'] = (fixtureModule, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  fixtureModule._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { createAdminDemoProviderRepository } = require('../lib/admin-demo-provider-repository.ts');
const { decryptCredential } = require('../lib/binance-credentials.ts');
process.env.BINANCE_CREDENTIALS_KEY = '1a'.repeat(32);
globalThis.fetch = () => { throw new Error('No provider traffic during the rehearsal'); };
const db = new pg.Client({ host: '127.0.0.1', port: 53104, database: 'scanner_fixture', user: 'scanner_fixture', ssl: false });
await db.connect();
try {
  const identity = (await db.query('SELECT current_database() AS db, current_user AS role, inet_server_addr() AS host')).rows[0];
  assert.deepEqual(identity, { db: 'scanner_fixture', role: 'scanner_fixture', host: '127.0.0.1' });
  await db.query('BEGIN');
  const actor = (await db.query("SELECT id FROM public.users WHERE email='fixture-admin@example.invalid'")).rows[0].id;
  await db.query('INSERT INTO public.admin_demo_identities (admin_user_id,is_active) VALUES($1,true)', [actor]);
  const query = (sql, values) => db.query(sql, values);
  const repo = createAdminDemoProviderRepository({ query, transaction: work => work(query),
    rpc: () => { throw new Error('No RPC during credential rehearsal'); } });
  for (const provider of ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE']) {
    const key = `fixture-key-${provider}`;
    const secret = `fixture-secret-${provider}`;
    const passphrase = ['OKX', 'BITGET'].includes(provider) ? `fixture-pass-${provider}` : undefined;
    const status = await repo.saveCredential(actor, provider, { apiKey: key, apiSecret: secret, passphrase, ownerConfirmed: true });
    assert.equal(status.configured, true);
    const raw = (await query(`SELECT api_key_ciphertext,secret_key_ciphertext,passphrase_ciphertext,is_enabled,environment
      FROM public.admin_demo_exchange_credentials WHERE admin_user_id=$1 AND provider=$2`, [actor,provider])).rows[0];
    assert.equal(raw.environment, provider === 'GATE' ? 'TESTNET' : 'DEMO');
    assert.equal(raw.is_enabled, false);
    assert.notEqual(raw.api_key_ciphertext, key);
    assert.notEqual(raw.secret_key_ciphertext, secret);
    assert.equal(decryptCredential(raw.api_key_ciphertext), key);
    assert.equal(decryptCredential(raw.secret_key_ciphertext), secret);
    assert.equal(raw.passphrase_ciphertext ? decryptCredential(raw.passphrase_ciphertext) : undefined, passphrase);
    assert.equal(await repo.revokeCredential(actor, provider, { erase: true }), true);
    assert.equal(await repo.revokeCredential(actor, provider, { erase: true }), false);
    const removed = (await query(`SELECT api_key_ciphertext='',secret_key_ciphertext='',passphrase_ciphertext IS NULL,
      revoked_at IS NOT NULL FROM public.admin_demo_exchange_credentials WHERE admin_user_id=$1 AND provider=$2`,
    [actor,provider])).rowCount;
    assert.equal(removed, 1);
  }
  const erased = (await query(`SELECT count(*)::int AS count FROM public.admin_demo_exchange_credentials
    WHERE admin_user_id=$1 AND api_key_ciphertext='' AND secret_key_ciphertext=''
      AND passphrase_ciphertext IS NULL AND revoked_at IS NOT NULL`, [actor])).rows[0].count;
  assert.equal(erased, 5);
  const audited = (await query(`SELECT count(*)::int AS count FROM public.admin_demo_exchange_audit_events
    WHERE admin_user_id=$1 AND event_type IN ('CREDENTIAL_SAVED','CREDENTIAL_REVOKED')`, [actor])).rows[0].count;
  assert.equal(audited, 10);
  console.log('PASS five-provider encrypted Demo credential save, disabled defaults, tombstone scrubbing, idempotent revoke and audit');
} finally {
  try { await db.query('ROLLBACK'); } finally { await db.end(); }
}
