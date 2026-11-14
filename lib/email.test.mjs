import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

const variableNames = [
  'APP_URL',
  'VERCEL_ENV',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
  'GMAIL_SMTP_PORT',
  'RESEND_API_KEY',
  'MAIL_FROM',
];
const originalValues = new Map(variableNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const { sendPasswordResetCode, verificationLink } = await import('./email.ts');

afterEach(() => {
  for (const [name, value] of originalValues) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = originalFetch;
});

test('Preview verification links use the deployment host instead of the Production host', () => {
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'preview';
  delete process.env.VERCEL_BRANCH_URL;
  process.env.VERCEL_URL = 'smartexit-preview.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  const link = verificationLink('user@example.test', '123456');
  assert.equal(new URL(link).origin, 'https://smartexit-preview.vercel.app');
});

test('Preview rejects a Production APP_URL', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.APP_URL = 'https://cryptohub.vercel.app';
  process.env.VERCEL_URL = 'smartexit-preview.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  assert.throws(() => verificationLink('user@example.test', '123456'), /must not use the Production host/);
});

test('Preview without a Preview host never falls back to the Production host', () => {
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'preview';
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  assert.throws(() => verificationLink('user@example.test', '123456'), /must identify the Preview origin/);
});

test('Preview rejects insecure localhost verification links', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.APP_URL = 'http://localhost:3000';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  assert.throws(() => verificationLink('user@example.test', '123456'), /must use HTTPS/);
});

test('Production verification links continue to use the Production host', () => {
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'production';
  process.env.VERCEL_URL = 'production-deployment.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  const link = verificationLink('user@example.test', '123456');
  assert.equal(new URL(link).origin, 'https://cryptohub.vercel.app');
});

test('Non-deployment environments preserve the Production-host fallback', () => {
  delete process.env.APP_URL;
  delete process.env.VERCEL_ENV;
  process.env.VERCEL_URL = 'local-deployment.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  const link = verificationLink('user@example.test', '123456');
  assert.equal(new URL(link).origin, 'https://cryptohub.vercel.app');
});
test('Preview verification links prefer the stable branch host', () => {
  delete process.env.APP_URL;
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_BRANCH_URL = 'smartexit-staging.vercel.app';
  process.env.VERCEL_URL = 'smartexit-preview.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'cryptohub.vercel.app';

  const link = verificationLink('user@example.test', '123456');
  assert.equal(new URL(link).origin, 'https://smartexit-staging.vercel.app');
});

test('password reset email contains the code without an account-specific link', async () => {
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'test@example.test';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true };
  };

  await sendPasswordResetCode('user@example.test', '123456');

  assert.equal(requestBody.subject, 'Your ETHcryptohub password reset code');
  assert.match(requestBody.text, /123456/);
  assert.doesNotMatch(requestBody.text, /user@example\.test/);
});
