import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXPECTED_MIGRATIONS, EXPECTED_VERIFICATION_FILES } from './validate-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationName = '202611110007_admin_demo_exchange_neutral.sql';
const migrationPath = path.join(root, 'supabase', 'migrations', migrationName);
const verificationPath = path.join(root, 'supabase', 'verification', migrationName);

test('exchange-neutral Admin Demo schema enforces provider, environment, identity, and ownership scope', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE TYPE public\.admin_demo_provider AS ENUM \('BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'\)/);
  assert.match(sql, /provider = 'GATE' AND environment = 'TESTNET'/);
  assert.match(sql, /provider <> 'GATE' AND environment = 'DEMO'/);
  assert.match(sql, /admin_scope TEXT NOT NULL DEFAULT 'ADMIN' CHECK \(admin_scope = 'ADMIN'\)/);
  assert.match(sql, /admin_user_id INTEGER PRIMARY KEY REFERENCES public\.users\(id\)/);
  assert.doesNotMatch(sql, /REFERENCES auth\.users/);
  assert.match(sql, /REFERENCES public\.admin_demo_identities \(admin_user_id, admin_scope\)/);
  assert.match(sql, /REFERENCES public\.admin_demo_exchange_credentials\s+\(id, admin_user_id, admin_scope, provider, environment\)/);
  assert.match(sql, /REFERENCES public\.admin_demo_exchange_sessions\s+\(id, admin_user_id, admin_scope, provider, environment\)/);
  assert.match(sql, /REFERENCES public\.admin_demo_exchange_authorizations\s+\(id, session_id, admin_user_id, admin_scope, provider, environment\)/);
  assert.match(sql, /is_active BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('Admin Demo tables are isolated, RLS-enabled, and execution remains disabled in CONFIRM mode', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  for (const table of [
    'admin_demo_identities',
    'admin_demo_exchange_credentials',
    'admin_demo_exchange_sessions',
    'admin_demo_exchange_authorizations',
    'admin_demo_exchange_executions',
    'admin_demo_exchange_audit_events',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /is_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /execution_mode TEXT NOT NULL DEFAULT 'CONFIRM' CHECK \(execution_mode = 'CONFIRM'\)/);
  assert.match(sql, /session_status TEXT NOT NULL DEFAULT 'CREATED'/);
  assert.match(sql, /entry_order_type TEXT NOT NULL CHECK \(entry_order_type IN \('MARKET', 'LIMIT'\)\)/);
  assert.match(sql, /execution_status TEXT NOT NULL DEFAULT 'CREATED'/);
  assert.match(sql, /stop_client_order_id VARCHAR\(36\) NOT NULL UNIQUE/);
  assert.match(sql, /UNIQUE \(session_id\)/);
  assert.match(sql, /owner_confirmed_at IS NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX admin_demo_exchange_credentials_one_active_provider_idx[\s\S]+WHERE revoked_at IS NULL/);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /TO service_role/);
  const auditDefinition = sql.split('CREATE TABLE public.admin_demo_exchange_audit_events')[1]?.split('ALTER TABLE')[0] ?? '';
  assert.doesNotMatch(auditDefinition, /api_key_ciphertext|secret_key_ciphertext|passphrase_ciphertext/i);
  assert.match(auditDefinition, /session_id BIGINT,/);
  assert.match(auditDefinition, /authorization_id BIGINT,/);
  assert.match(auditDefinition, /CHECK \(\(session_id IS NULL\) = \(authorization_id IS NULL\)\)/);
  assert.match(auditDefinition, /'CREDENTIAL_SAVED', 'CREDENTIAL_REVOKED'/);
});

test('service-role RPC consumes scoped authorizations atomically for START_TEST and RECONCILE only', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  const functionSql = sql.split('CREATE OR REPLACE FUNCTION public.authorize_admin_demo_exchange_action')[1] ?? '';
  assert.match(functionSql, /SECURITY DEFINER/);
  assert.match(functionSql, /SET search_path = pg_catalog, public/);
  assert.match(functionSql, /auth\.role\(\).*service_role/);
  assert.match(functionSql, /p_action NOT IN \('START_TEST', 'RECONCILE'\)/);
  assert.match(functionSql, /FOR UPDATE OF a, s/);
  assert.match(functionSql, /consumed_at = CURRENT_TIMESTAMP/);
  assert.match(functionSql, /session_status IN \('RUNNING', 'RECONCILIATION_REQUIRED'\)/);
  assert.match(functionSql, /c\.revoked_at IS NULL/);
  assert.match(functionSql, /i\.is_active/);
  assert.match(functionSql, /INSERT INTO public\.admin_demo_exchange_audit_events/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.authorize_admin_demo_exchange_action[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.authorize_admin_demo_exchange_action[\s\S]+TO service_role/);
  assert.doesNotMatch(functionSql, /INSERT INTO public\.admin_demo_exchange_executions/);
});

test('paired verification is read-only and migration validator tracks the versioned pair', async () => {
  const sql = await readFile(verificationPath, 'utf8');
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/i);
  assert.match(sql, /rls_disabled_table/);
  assert.match(sql, /browser_table_privilege/);
  assert.match(sql, /credential_columns_in_audit_events/);
  assert.match(sql, /audit_scope_pairing_mismatch/);
  assert.ok(EXPECTED_MIGRATIONS.includes(migrationName));
  assert.ok(EXPECTED_VERIFICATION_FILES.includes(migrationName));
});
