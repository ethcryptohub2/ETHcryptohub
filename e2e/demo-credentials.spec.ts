import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import ts from 'typescript';

const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
const packageSource = (name: string, file: string) =>
  readFileSync(path.join(path.dirname(localRequire.resolve(name)), 'cjs', file), 'utf8');

function browserFixture() {
  const component = readFileSync('app/admin/exchanges/testing/demo-credential-storage.tsx', 'utf8');
  const panel = ts.transpileModule(component, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const modules = {
    react: packageSource('react', 'react.production.js'),
    'react/jsx-runtime': packageSource('react', 'react-jsx-runtime.production.js'),
    'react-dom': packageSource('react-dom', 'react-dom.production.js'),
    'react-dom/client': packageSource('react-dom', 'react-dom-client.production.js'),
    scheduler: packageSource('scheduler', 'scheduler.production.js'),
    './exchange-demo-review.module.css': 'module.exports = {};',
    panel,
  };
  return `(() => {
    const process = { env: { NODE_ENV: 'production' } };
    const definitions = {
      ${Object.entries(modules).map(([name, source]) => `${JSON.stringify(name)}: (require, module, exports) => {\n${source}\n}`).join(',\n')}
    };
    const cache = {};
    function require(name) {
      if (cache[name]) return cache[name].exports;
      const mod = cache[name] = { exports: {} };
      definitions[name](require, mod, mod.exports);
      return mod.exports;
    }
    const React = require('react');
    const { DemoCredentialStorage } = require('panel');
    const root = require('react-dom/client').createRoot(document.querySelector('main'));
    root.render(React.createElement(DemoCredentialStorage, { provider: 'OKX', environment: 'DEMO', name: 'OKX', passphrase: true }));
  })();`;
}

test('Demo credential controls honor readiness and send only synthetic scoped mutations', async ({ page }) => {
  const origin = 'https://demo-credential-fixture.test';
  const path = '/api/admin/demo/providers/OKX/credential-storage';
  let approved = false;
  let configured = false;
  const mutations: string[] = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
    if (url.pathname === '/api/csrf') return route.fulfill({ json: { data: { csrfToken: 'synthetic-csrf' } } });
    if (url.pathname !== path) return route.abort();
    if (request.method() === 'GET') return route.fulfill({ json: { data: {
      state: approved ? 'READY' : 'SCHEMA_REQUIRED', enabled: approved, removalEnabled: configured,
      configured, updatedAt: null,
    } } });
    expect(request.headers()['x-csrf-token']).toBe('synthetic-csrf');
    mutations.push(request.method());
    if (request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({
        apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-pass', ownerConfirmed: true, environment: 'DEMO',
      });
      configured = true;
      return route.fulfill({ status: 201, json: { data: { configured: true } } });
    }
    expect(request.method()).toBe('DELETE');
    expect(request.postData()).toBeNull();
    configured = false;
    return route.fulfill({ json: { data: { revoked: true } } });
  });
  await page.goto(origin);
  await page.addScriptTag({ content: browserFixture() });
  await expect(page.getByText('The reviewed Staging credential schema is required.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save credentials' })).toBeDisabled();
  expect(mutations).toEqual([]);

  approved = true;
  await page.reload();
  await page.addScriptTag({ content: browserFixture() });
  await expect(page.getByRole('button', { name: 'Save credentials' })).toBeEnabled();
  await expect(page.getByLabel('Passphrase')).toHaveAttribute('type', 'password');
  await page.getByLabel('API key').fill('fixture-key');
  await page.getByLabel('API secret').fill('fixture-secret');
  await page.getByLabel('Passphrase').fill('fixture-pass');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save credentials' }).click();
  await expect(page.getByText('Encrypted credential stored with execution disabled.')).toBeVisible();
  await expect(page.getByLabel('API secret')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove credential' })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove credential' }).click();
  await expect(page.getByText('Credential removal completed. Audit records are retained.')).toBeVisible();
  expect(mutations).toEqual(['POST', 'DELETE']);
});
