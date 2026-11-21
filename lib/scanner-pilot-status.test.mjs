import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('pilot history is Admin-only, Staging-only and tolerates the unapplied draft', async t => {
  const filename = path.resolve('app/api/admin/scanner-pilot/route.ts');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  let authorized = false;
  let installed = false;
  const statements = [];
  class AuthError extends Error { status = 403; }
  mod.require = key => ({
    '../../../../lib/auth': { AuthError, requireAdmin: async () => { if (!authorized) throw new AuthError(); } },
    '../../../../lib/admin-demo-staging-policy': { isApprovedAdminDemoStagingTarget: () => true },
    '../../../../lib/db': { query: async statement => {
      statements.push(statement);
      return { rows: statement.includes('to_regclass') ? [{ installed }] : [{ state: 'COMPLETED' }] };
    } },
  })[key];
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  const { GET } = mod.exports;
  for (const key of ['VERCEL_ENV', 'SMARTEXIT_STAGING_SUPABASE_PROJECT_REF', 'SMARTEXIT_SCANNER_PILOT_ENABLED']) {
    const value = process.env[key];
    t.after(() => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
  process.env.VERCEL_ENV = 'preview';
  process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF = 'ghecpkpaxbrvehquhzkr';
  delete process.env.SMARTEXIT_SCANNER_PILOT_ENABLED;
  assert.equal((await GET()).status, 403);
  authorized = true;
  process.env.VERCEL_ENV = 'production';
  assert.equal((await (await GET()).json()).state, 'OUTSIDE_STAGING');
  assert.deepEqual(statements, []);
  process.env.VERCEL_ENV = 'preview';
  assert.equal((await (await GET()).json()).state, 'SCHEMA_PENDING');
  assert.equal(statements.length, 1);
  installed = true;
  const response = await GET();
  assert.deepEqual(await response.json(), { state: 'DISABLED', runs: [{ state: 'COMPLETED' }] });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(statements.every(statement => statement.startsWith('SELECT')));
  assert.match(statements.at(-1), /LIMIT 10/);
});
