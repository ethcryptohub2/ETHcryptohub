import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDatabaseAccessAllowed,
  decideUiPreviewRequest,
} from './ui-preview-mode.mjs';
import { UI_PREVIEW_PROJECT_ID } from './ui-preview-mode.mjs';

const validEnvironment = {
  SMARTEXIT_UI_PREVIEW_ONLY: 'true',
  SMARTEXIT_UI_PREVIEW_BRANCH: 'fix/smart-exit-preview',
  VERCEL_ENV: 'preview',
  VERCEL_PROJECT_ID: UI_PREVIEW_PROJECT_ID,
  VERCEL_GIT_COMMIT_REF: 'fix/smart-exit-preview',
  VERCEL_URL: 'cryptohub-preview-123.vercel.app',
};

function vercelOidcToken(environment = 'preview', projectId = UI_PREVIEW_PROJECT_ID) {
  const subject = `owner:eth-cryptohub:project:cryptohub:environment:${environment}`;
  const claims = {
    iss: 'https://oidc.vercel.com/eth-cryptohub',
    aud: 'https://vercel.com/eth-cryptohub',
    sub: subject,
    scope: subject,
    owner: 'eth-cryptohub',
    project: 'cryptohub',
    project_id: projectId,
    environment,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

test('UI Preview permits only public and static GET/HEAD requests', () => {
  assert.equal(decideUiPreviewRequest(validEnvironment, '/', 'GET'), 'next');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/icon.svg', 'GET'), 'next');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/dashboard', 'GET'), 'unavailable');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/api/auth/me', 'GET'), 'reject');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/api/trading', 'POST'), 'reject');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/settings', 'POST'), 'reject');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/_next/data/secret.json', 'GET'), 'unavailable');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/service-worker.js', 'GET'), 'reject');
  assert.equal(decideUiPreviewRequest(validEnvironment, '/_next/image?url=https://example.com/image.png', 'GET'), 'reject');
});

test('UI Preview accepts only a Preview-scoped Vercel OIDC system token', () => {
  assert.equal(decideUiPreviewRequest({
    ...validEnvironment,
    VERCEL_OIDC_TOKEN: vercelOidcToken(),
  }, '/', 'GET'), 'next');

  for (const token of [
    vercelOidcToken('production'),
    vercelOidcToken('preview', 'wrong-project'),
    'malformed-token',
  ]) {
    assert.equal(decideUiPreviewRequest({
      ...validEnvironment,
      VERCEL_OIDC_TOKEN: token,
    }, '/', 'GET'), 'reject');
  }
});

test('database access fails closed for enabled or malformed UI Preview flags', () => {
  assert.throws(
    () => assertDatabaseAccessAllowed({ SMARTEXIT_UI_PREVIEW_ONLY: 'true' }),
    /Database access is disabled in UI Preview/,
  );
  assert.throws(
    () => assertDatabaseAccessAllowed({ SMARTEXIT_UI_PREVIEW_ONLY: 'yes' }),
    /Database access is disabled in UI Preview/,
  );
  assert.doesNotThrow(() => assertDatabaseAccessAllowed({ SMARTEXIT_UI_PREVIEW_ONLY: 'false' }));
});

test('an invalid Production Preview configuration is rejected before routing', () => {
  assert.equal(decideUiPreviewRequest({
    ...validEnvironment,
    VERCEL_ENV: 'production',
  }, '/', 'GET'), 'reject');
  assert.equal(decideUiPreviewRequest({
    ...validEnvironment,
    VERCEL_PROJECT_ID: 'wrong-project',
  }, '/dashboard', 'GET'), 'reject');
});
