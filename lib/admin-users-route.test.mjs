import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const file = fileURLToPath(new URL('../app/api/admin/users/route.ts', import.meta.url));
const route = new Module(file);
route.filename = file;
route.paths = Module._nodeModulePaths(process.cwd());
const statements = [];
const load = Module._load;
try {
  Module._load = function loadFixture(name, parent, isMain) {
    if (name.endsWith('/lib/auth')) return {
      AuthError: class extends Error {},
      requireAdmin: async () => ({ id: 1 }),
    };
    if (name.endsWith('/lib/db')) {
      const query = async (sql) => {
        statements.push(sql);
        return { rowCount: 0 };
      };
      return { query, pool: () => ({ connect: async () => ({ query, release() {} }) }) };
    }
    if (name.endsWith('/lib/http')) return { validCsrf: () => true };
    if (name.endsWith('/lib/pagination')) return { TABLE_PAGE_SIZE: 20 };
    return load.call(this, name, parent, isMain);
  };
  route._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file);
} finally {
  Module._load = load;
}

test('Admin user mutations guard privileged target roles in the write itself', async () => {
  for (const action of ['toggle_active', 'delete_user', 'mark_email_verified']) {
    statements.length = 0;
    const result = await route.exports.POST({ json: async () => ({ action, userId: 2 }) });
    assert.equal(result.status, 404, action);
    const write = statements.find((sql) => /^(UPDATE|DELETE)/.test(sql));
    assert.match(write, /WHERE id = \$1.*AND role <> 'admin'/);
    assert.equal(statements.some((sql) => sql.includes('email_verification_codes')), false);
  }
});

test('Admin user mutations return 400 for malformed JSON before any write', async () => {
  statements.length = 0;
  const result = await route.exports.POST({
    json: async () => { throw new SyntaxError('invalid JSON'); },
  });
  assert.equal(result.status, 400);
  assert.deepEqual(statements, []);
});
