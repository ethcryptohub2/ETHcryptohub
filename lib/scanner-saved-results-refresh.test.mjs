import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const component = readFileSync(new URL('../app/scanner/saved-results-refresh.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(component, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

test('saved-result polling uses the selected cadence, skips hidden pages and cleans up', () => {
  const listeners = new Map();
  const timers = new Map();
  const window = {
    setInterval(callback, interval) { timers.set(interval, callback); return interval; },
    clearInterval(interval) { timers.delete(interval); },
  };
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) {
      assert.equal(listeners.get(name), callback);
      listeners.delete(name);
    },
  };
  let cleanup;
  const exports = {};
  const require = name => name === 'react' ? { useEffect(effect) { cleanup = effect(); } } : {};
  new Function('require', 'exports', 'window', 'document', compiled)(require, exports, window, document);
  let reads = 0;
  const load = async () => { reads += 1; };
  for (const minutes of [2, 1, 5]) {
    const prior = reads;
    exports.useSavedResultsPolling(load, minutes);
    assert.deepEqual([...timers.keys()], [minutes * 60_000]);
    document.visibilityState = 'hidden';
    timers.get(minutes * 60_000)();
    listeners.get('visibilitychange')();
    assert.equal(reads, prior);
    document.visibilityState = 'visible';
    listeners.get('visibilitychange')();
    timers.get(minutes * 60_000)();
    assert.equal(reads, prior + 2);
    cleanup();
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
  }
});
