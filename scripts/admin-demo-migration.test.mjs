import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '202611110004_admin_binance_demo_testing.sql');
const grantPath = path.join(root, 'supabase', 'migrations', '202611110005_admin_binance_demo_rpc_grant.sql');

test('Admin Demo schema is fixed to Binance Demo and isolated from customer execution tables', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /environment VARCHAR\(8\) NOT NULL DEFAULT 'DEMO' CHECK \(environment = 'DEMO'\)/);
  assert.match(sql, /exchange VARCHAR\(16\) NOT NULL DEFAULT 'BINANCE' CHECK \(exchange = 'BINANCE'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.admin_demo_test_executions/);
  assert.doesNotMatch(sql, /public\.(?:trade_executions|binance_api_credentials|exchange_api_credentials)\b/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.authorize_admin_demo_test_action/);
  assert.match(sql, /a\.consumed_at IS NULL/);
  assert.match(sql, /a\.expires_at > CURRENT_TIMESTAMP/);
});

test('Admin Demo authorization function binds the session, Admin and permitted action', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  const functionSql = sql.split('CREATE OR REPLACE FUNCTION public.authorize_admin_demo_test_action')[1];
  assert.ok(functionSql);
  assert.match(functionSql, /p_admin_user_id/);
  assert.match(functionSql, /p_session_id/);
  assert.match(functionSql, /p_authorization_id/);
  assert.match(functionSql, /p_action = ANY\(a\.permitted_actions\)/);
  assert.match(functionSql, /SECURITY DEFINER/);
  assert.match(functionSql, /SET search_path = pg_catalog, public/);
  assert.match(functionSql, /consumed_at = CURRENT_TIMESTAMP/);
});

test('only the Supabase server role receives the atomic authorization RPC grant', async () => {
  const sql = (await readFile(grantPath, 'utf8')).replace(/--.*$/gm, '');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.authorize_admin_demo_test_action\(INTEGER, BIGINT, BIGINT, TEXT\)\s+TO service_role/);
  assert.doesNotMatch(sql, /TO\s+(?:PUBLIC|anon|authenticated)\b/i);
});
