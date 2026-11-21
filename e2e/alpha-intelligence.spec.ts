import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { disabledAlphaSnapshot, type AlphaObservation, type AlphaSnapshot } from '../lib/alpha-intelligence';

declare global {
  interface Window {
    renderAlphaFixture: (value: AlphaSnapshot, isAdmin: boolean) => void;
  }
}

const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
const read = (file: string) => readFileSync(file, 'utf8');
const packageSource = (name: string, file: string) => read(path.join(path.dirname(localRequire.resolve(name)), 'cjs', file));
const alphaComponent = 'app/scanner/alpha-intelligence.tsx';
const alphaCss = read('app/scanner/alpha-intelligence.module.css');
const cssModule = Object.fromEntries([...alphaCss.matchAll(/\.([A-Za-z][A-Za-z0-9]*)/g)].map(([, name]) => [name, name]));

function browserFixture() {
  const panel = ts.transpileModule(read(alphaComponent), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const modules = {
    react: packageSource('react', 'react.production.js'),
    'react/jsx-runtime': packageSource('react', 'react-jsx-runtime.production.js'),
    'react-dom': packageSource('react-dom', 'react-dom.production.js'),
    'react-dom/client': packageSource('react-dom', 'react-dom-client.production.js'),
    scheduler: packageSource('scheduler', 'scheduler.production.js'),
    './alpha-intelligence.module.css': `module.exports = ${JSON.stringify(cssModule)}`,
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
      const module = cache[name] = { exports: {} };
      definitions[name](require, module, module.exports);
      return module.exports;
    }
    const React = require('react');
    const { AlphaIntelligence } = require('panel');
    const root = require('react-dom/client').createRoot(document.querySelector('main'));
    function Fixture({ snapshot, isAdmin }) {
      const [watchlist, setWatchlist] = React.useState([]);
      const [observations, setObservations] = React.useState(null);
      const onToggleWatchlist = id => setWatchlist(values => values.includes(id)
        ? values.filter(value => value !== id) : [...values, id]);
      return React.createElement(AlphaIntelligence, { snapshot: observations ?? snapshot, watchlist, onToggleWatchlist,
        isAdmin, onSnapshot: setObservations });
    }
    window.renderAlphaFixture = (snapshot, isAdmin) => root.render(React.createElement(Fixture, { snapshot, isAdmin }));
  })();`;
}

const mount = (page: import('@playwright/test').Page, snapshot: AlphaSnapshot, isAdmin = false) =>
  page.evaluate(data => window.renderAlphaFixture(data.snapshot, data.isAdmin), { snapshot, isAdmin });

test('Alpha dashboard renders disabled sources, filters observations and updates the session watchlist offline', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/*', route => route.abort());
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const localStyles = read('app/globals.css').replace(/^@import[^\r\n]+\r?\n/m, '');
  await page.setContent(`<style>${localStyles}\n${alphaCss}</style><main class="shell"></main>`);
  await page.addScriptTag({ content: browserFixture() });
  const disabled = disabledAlphaSnapshot();
  await mount(page, disabled);
  await expect(page.getByRole('heading', { name: 'Binance Alpha Intelligence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Source health' })).toBeVisible();
  await expect(page.getByText('No verified Alpha observations')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Documentation for Alpha token registry' })).toBeVisible();
  await expect(page.getByText('No approved, verified source is configured.').first()).toBeVisible();

  const token: AlphaObservation = {
    id: 'fixture-a', symbol: 'AAA', name: 'Fixture A', chain: 'Fixture Chain', contract: '0x123',
    market: 'AAA/USDT', price: 2, quoteVolume24h: 200, volumeChangePercent: 5, momentumPercent: 10,
    liquidity: 'UNAVAILABLE', bidDepthQuote: null, askDepthQuote: null, flows: null, holderConcentration: null,
    contractRisk: null, campaigns: null, sentiment: null, xActivity: null, youtubeActivity: null,
    engagementAnomaly: null, riskScore: null, signalStatus: 'OBSERVATION_ONLY', verifiedAt: '2026-11-20T12:00:00.000Z',
    sourceLinks: ['https://example.test/market'],
  };
  await mount(page, { ...disabled, rows: [token, { ...token, id: 'fixture-b', symbol: 'BBB',
    name: 'Fixture B', volumeChangePercent: 20, contract: '0x456' }] });
  await expect(page.getByText('Observation only', { exact: true })).toHaveCount(2);
  await page.getByLabel('Sort by').selectOption('volume');
  await expect(page.getByRole('article').first()).toContainText('BBB');
  await page.getByRole('button', { name: 'Watch BBB' }).click();
  await expect(page.getByRole('button', { name: 'Watch BBB' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Watchlist only').check();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article').first()).toContainText('BBB');
  await page.getByLabel('Search token or contract').fill('0x123');
  await expect(page.getByText('No markets match these filters')).toBeVisible();
  await page.getByLabel('Search token or contract').clear();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(errors).toEqual([]);
});

test('Alpha Admin refresh checks the gate before any provider-triggering POST', async ({ page }) => {
  const calls: string[] = [];
  let approved = false;
  const disabled = disabledAlphaSnapshot();
  const checkedAt = '2026-11-20T12:00:00.000Z';
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'https://alpha-fixture.invalid') return route.abort();
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
    if (url.pathname === '/api/admin/alpha-intelligence' && request.method() === 'GET') {
      calls.push('readiness');
      return route.fulfill({ json: { enabled: approved } });
    }
    if (url.pathname === '/api/csrf') {
      calls.push('csrf');
      return route.fulfill({ json: { data: { csrfToken: 'local-fixture' } } });
    }
    if (url.pathname === '/api/admin/alpha-intelligence' && request.method() === 'POST' && approved) {
      calls.push('check');
      expect(request.headers()['x-csrf-token']).toBe('local-fixture');
      expect(request.postData()).toBeNull();
      return route.fulfill({ json: { data: { ...disabled, checkedAt } } });
    }
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  await page.goto('https://alpha-fixture.invalid/fixture');
  await page.addScriptTag({ content: browserFixture() });
  await mount(page, disabled, true);
  const check = page.getByRole('button', { name: 'Check approved Alpha sources' });
  await expect(page.getByText('Source acquisition requires separate approval.')).toBeVisible();
  await expect(check).toBeDisabled();
  expect(calls).toEqual(['readiness']);

  approved = true;
  await mount(page, disabled);
  await expect(check).toHaveCount(0);
  await mount(page, disabled, true);
  await expect(check).toBeEnabled();
  await check.click();
  await expect(page.getByText('Last source check 2026-11-20 12:00:00.000 UTC')).toBeVisible();
  expect(calls).toEqual(['readiness', 'readiness', 'csrf', 'check']);
});
