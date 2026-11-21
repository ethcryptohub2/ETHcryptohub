import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as shadow from './ai-shadow.ts';
import { sealAiShadowCredential, unsealAiShadowCredential } from './ai-shadow-credentials.ts';

const configPath = path.resolve('lib/ai-shadow-config.ts');
const configModule = new Module(configPath);
configModule.filename = configPath;
configModule.paths = Module._nodeModulePaths(path.dirname(configPath));
const requireDependency = configModule.require.bind(configModule);
configModule.require = (name) => name === './ai-shadow' ? shadow : requireDependency(name);
configModule._compile(ts.transpileModule(fs.readFileSync(configPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, configPath);
const { loadAiShadowConfig, runAiShadowFixture, RetryableAiShadowFixtureError } = configModule.exports;

const env = {
  SMARTEXIT_AI_SHADOW_MODE: 'fixture', SMARTEXIT_AI_GEMINI_MODEL: 'gemini-fixture',
  SMARTEXIT_AI_CLAUDE_MODEL: 'claude-fixture', SMARTEXIT_AI_SHADOW_TIMEOUT_MS: '100',
};
const evaluatedAt = '2026-11-22T12:00:00.000Z';
const evidence = shadow.normalizeAiShadowEvidence({
  candidateSignalId: 'fixture-38', strategy: 'STANDARD', symbol: 'BTCUSDT',
  side: 'LONG', evaluatedAt, observations: [],
});
const structure = { agent: 'MARKET_STRUCTURE', provider: 'GEMINI', promptVersion: 'v1' };
const momentum = { agent: 'VOLUME_MOMENTUM', provider: 'CLAUDE', promptVersion: 'v1' };
function response(review) {
  return {
    agent: review.agent, provider: review.provider, model: review.model, promptVersion: review.promptVersion,
    candidateSignalId: review.candidateSignalId, strategy: review.strategy, marketRegime: 'UNKNOWN',
    evidenceAsOf: review.evaluatedAt, supportingFactors: [], conflictingFactors: [], missingEvidence: review.missingEvidence,
    decision: 'NEEDS_REVIEW', explanation: 'Fixture lacks recent observations.',
  };
}

test('AI provider configuration defaults off, emits model metadata only and rejects live activation', async () => {
  assert.equal(loadAiShadowConfig({}).mode, 'off');
  const metadata = loadAiShadowConfig({ ...env, SMARTEXIT_AI_GEMINI_API_KEY: 'fixture-secret-marker' });
  assert.equal(metadata.models.GEMINI, 'gemini-fixture');
  assert.equal(JSON.stringify(metadata).includes('fixture-secret-marker'), false);
  assert.throws(() => loadAiShadowConfig({ SMARTEXIT_AI_SHADOW_MODE: 'live' }), /^Error: Invalid AI shadow configuration\.$/);
  assert.throws(() => loadAiShadowConfig({ SMARTEXIT_AI_GEMINI_MODEL: 'sk-fixture-value' }), /^Error: Invalid AI shadow configuration\.$/);
  assert.throws(() => loadAiShadowConfig({ SMARTEXIT_AI_SHADOW_MAX_ATTEMPTS: '13' }));
  const output = await runAiShadowFixture({
    config: loadAiShadowConfig({}), evidence, assignments: [structure],
    oracle: async () => assert.fail('disabled fixture attempted transport'),
  });
  assert.equal(output.status, 'DISABLED');
  assert.equal(output.attempts, 0);
  assert.equal(output.executionEligible, false);
});

test('offline oracle retry is capped globally and returns validated fixture-only shadow results', async () => {
  let called = 0;
  const output = await runAiShadowFixture({
    config: loadAiShadowConfig({ ...env, SMARTEXIT_AI_SHADOW_MAX_ATTEMPTS: '2' }), evidence,
    assignments: [structure, momentum], oracle: async (review) => {
      called++;
      assert.equal('apiKey' in review, false);
      if (called === 1) throw new RetryableAiShadowFixtureError();
      return response(review);
    },
  });
  assert.equal(called, 2);
  assert.equal(output.attempts, 2);
  assert.equal(output.decisions.length, 1);
  assert.equal(output.source, 'OFFLINE_FIXTURE');
  assert.equal(output.executionEligible, false);
  assert.deepEqual(output.failures, [{ agent: 'VOLUME_MOMENTUM', code: 'BUDGET_EXHAUSTED' }]);
});

test('oracle failures stay opaque and invalid responses are not retried', async () => {
  let called = 0;
  const output = await runAiShadowFixture({
    config: loadAiShadowConfig(env), evidence, assignments: [structure, momentum],
    oracle: async (review) => {
      if (++called === 1) return { ...response(review), oversizedPrivateField: 'fixture-secret-marker' };
      throw new Error('fixture-secret-marker');
    },
  });
  assert.equal(called, 2);
  assert.deepEqual(output.failures.map(({ code }) => code), ['INVALID_DECISION', 'MOCK_ERROR']);
  assert.equal(JSON.stringify(output).includes('fixture-secret-marker'), false);
});

test('deadline aborts a fixture request and does not retry an unresponsive oracle', async () => {
  let signal;
  const output = await runAiShadowFixture({
    config: loadAiShadowConfig(env), evidence, assignments: [structure], oracle: async (_review, abort) => {
      signal = abort;
      await new Promise(() => {});
    },
  });
  assert.equal(signal.aborted, true);
  assert.equal(output.attempts, 1);
  assert.deepEqual(output.failures, [{ agent: 'MARKET_STRUCTURE', code: 'MOCK_TIMEOUT' }]);
});

test('server-side credential helpers authenticate provider, scope and ciphertext independently', () => {
  const key = '11'.repeat(32);
  const context = { provider: 'OPENAI', scope: 'staging-fixture' };
  const secret = 'synthetic-opaque-value';
  const sealed = sealAiShadowCredential(secret, context, key);
  assert.equal(sealed.includes(secret), false);
  assert.notEqual(sealed, sealAiShadowCredential(secret, context, key));
  assert.equal(unsealAiShadowCredential(sealed, context, key), secret);
  assert.throws(() => unsealAiShadowCredential(sealed, { ...context, provider: 'CLAUDE' }, key));
  assert.throws(() => unsealAiShadowCredential(sealed, { ...context, scope: 'some-other-scope' }, key));
  assert.throws(() => unsealAiShadowCredential(sealed, context, '22'.repeat(32)));
  assert.throws(() => unsealAiShadowCredential(`${sealed.slice(0, -1)}${sealed.endsWith('0') ? '1' : '0'}`, context, key));
  assert.throws(() => unsealAiShadowCredential(sealed + '.ignored', context, key));
  assert.throws(() => sealAiShadowCredential('fixture with spaces', context, key));
});
