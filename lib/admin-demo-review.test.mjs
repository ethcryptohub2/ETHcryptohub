import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

function load(relativePath, mocks = {}) {
  const filename = path.resolve(relativePath);
  const component = new Module(filename);
  component.filename = filename;
  component.paths = Module._nodeModulePaths(path.dirname(filename));
  const require = component.require.bind(component);
  component.require = key => key in mocks ? mocks[key] : require(key);
  component._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText, filename);
  return component.exports;
}

const contract = load('lib/admin-demo-provider-contract.ts');
const credentialStorage = load('app/admin/exchanges/testing/demo-credential-storage.tsx', {
  './exchange-demo-review.module.css': {},
});
for (const provider of contract.ADMIN_DEMO_PROVIDERS) {
  test(`${provider} Admin auto-trading labels its fixed environment and leaves execution controls disabled`, () => {
    const { ExchangeDemoReview } = load('app/admin/exchanges/testing/exchange-demo-review.tsx', {
      react: { useState: () => [provider, () => assert.fail('Render should not schedule execution')] },
      '../../../../lib/admin-demo-provider-contract': contract,
      './demo-credential-storage': credentialStorage,
      './exchange-demo-review.module.css': {},
    });
    const markup = renderToStaticMarkup(createElement(ExchangeDemoReview));
    assert.match(markup, new RegExp(`>${contract.ADMIN_DEMO_PROVIDER_ENVIRONMENTS[provider]}</span>`));
    assert.match(markup, /Not ready for remote testing/);
    assert.match(markup, /<fieldset disabled=""[^>]*aria-describedby="demo-automation-reason"[\s\S]+Start automatic Demo execution[\s\S]+Stop automatic Demo execution[\s\S]+Emergency kill switch[\s\S]+<\/fieldset>/);
    assert.match(markup, /Risk per trade<input readOnly="" value="1%"\//);
    assert.match(markup, /<fieldset disabled=""[^>]*aria-describedby="demo-credential-reason"[\s\S]+Remove credential/);
    assert.equal(markup.includes('Passphrase'), provider === 'OKX' || provider === 'BITGET');
    assert.doesNotMatch(markup, /<option[^>]*>Live</);
  });
}
