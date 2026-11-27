import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'strategy-management.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});

function createFixture(mockProfiles) {
  const sourceModule = new Module(sourcePath);
  sourceModule.filename = sourcePath;
  sourceModule.paths = Module._nodeModulePaths(directory);
  const originalLoad = Module._load;
  let lastInserted = null;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === sourcePath) {
      if (request === './db') {
        return {
          query: async (sql, params) => {
            if (sql.includes('to_regclass') || sql.includes('information_schema.columns')) {
              return { rows: [{ ready: true }] };
            }
            if (sql.includes('INSERT INTO public.user_strategy_settings')) {
              lastInserted = { sql, params };
              return { rows: [{ strategy: params[1], leverage: params[13] }] };
            }
            if (sql.includes('FROM public.user_strategy_settings')) {
              return { rows: mockProfiles };
            }
            return { rows: [] };
          },
        };
      }
      if (request === './exchanges/schema') {
        return { assertExchangeFoundationReady: async () => {} };
      }
      if (request === './exchanges/types') {
        return {
          isExchangeId: (val) => ['BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE'].includes(val),
          isExchangeEnvironment: (ex, env) => ['DEMO', 'TESTNET', 'LIVE'].includes(env),
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    sourceModule._compile(compiled.outputText, sourcePath);
    return { ...sourceModule.exports, getLastInserted: () => lastInserted };
  } finally {
    Module._load = originalLoad;
  }
}

test('requireExecutableStrategy permanently blocks LIVE execution with 403', async () => {
  const mod = createFixture([
    {
      strategy: 'STANDARD',
      exchange: 'BINANCE',
      environment: 'LIVE',
      enabled: true,
      execution_mode: 'CONFIRM',
      risk_percentage: '1.0',
      order_size_mode: 'RISK_BASED',
      fixed_notional_usdt: '100',
      leverage: 10,
      max_open_positions: 3,
      max_daily_loss_percent: '3.0',
      auto_execution_enabled: false,
      emergency_stop_enabled: false,
      updated_at: new Date().toISOString(),
    },
  ]);
  await assert.rejects(
    () => mod.requireExecutableStrategy(1, 'STANDARD', 'BINANCE', 'LIVE', 'CONFIRM'),
    (err) => err.status === 403 && /Live strategy execution remains strictly locked/i.test(err.message),
  );
});

test('requireExecutableStrategy rejects disabled strategy, destination mismatch, or active emergency stop', async () => {
  const mod = createFixture([
    {
      strategy: 'STANDARD',
      exchange: 'BINANCE',
      environment: 'DEMO',
      enabled: false,
      execution_mode: 'CONFIRM',
      risk_percentage: '1.0',
      order_size_mode: 'RISK_BASED',
      fixed_notional_usdt: '100',
      leverage: 10,
      max_open_positions: 3,
      max_daily_loss_percent: '3.0',
      auto_execution_enabled: false,
      emergency_stop_enabled: false,
      updated_at: new Date().toISOString(),
    },
  ]);
  await assert.rejects(
    () => mod.requireExecutableStrategy(1, 'STANDARD', 'BINANCE', 'DEMO', 'CONFIRM'),
    (err) => err.status === 403 && /disabled/i.test(err.message),
  );

  const modStopped = createFixture([
    {
      strategy: 'STANDARD',
      exchange: 'BINANCE',
      environment: 'DEMO',
      enabled: true,
      execution_mode: 'CONFIRM',
      risk_percentage: '1.0',
      order_size_mode: 'RISK_BASED',
      fixed_notional_usdt: '100',
      leverage: 10,
      max_open_positions: 3,
      max_daily_loss_percent: '3.0',
      auto_execution_enabled: false,
      emergency_stop_enabled: true,
      updated_at: new Date().toISOString(),
    },
  ]);
  await assert.rejects(
    () => modStopped.requireExecutableStrategy(1, 'STANDARD', 'BINANCE', 'DEMO', 'CONFIRM'),
    (err) => err.status === 409 && /emergency stop/i.test(err.message),
  );
});

test('requireExecutableStrategy allows authorized DEMO execution when limits and mode match', async () => {
  const validProfile = {
    strategy: 'STANDARD',
    exchange: 'BINANCE',
    environment: 'DEMO',
    enabled: true,
    execution_mode: 'CONFIRM',
    risk_percentage: '1.0',
    order_size_mode: 'RISK_BASED',
    fixed_notional_usdt: '100',
    leverage: 10,
    max_open_positions: 3,
    max_daily_loss_percent: '3.0',
    auto_execution_enabled: false,
    emergency_stop_enabled: false,
    updated_at: new Date().toISOString(),
  };
  const mod = createFixture([validProfile]);
  const profile = await mod.requireExecutableStrategy(1, 'STANDARD', 'BINANCE', 'DEMO', 'CONFIRM');
  assert.equal(profile.strategy, 'STANDARD');
  assert.equal(profile.environment, 'DEMO');
  assert.equal(profile.enabled, true);
});

test('requireExecutableStrategy permits automatic DEMO execution only when auto_execution_enabled is true', async () => {
  const autoProfile = {
    strategy: 'STANDARD',
    exchange: 'BINANCE',
    environment: 'DEMO',
    enabled: true,
    execution_mode: 'AUTOMATIC',
    risk_percentage: '1.0',
    order_size_mode: 'RISK_BASED',
    fixed_notional_usdt: '100',
    leverage: 10,
    max_open_positions: 3,
    max_daily_loss_percent: '3.0',
    auto_execution_enabled: true,
    emergency_stop_enabled: false,
    updated_at: new Date().toISOString(),
  };
  const mod = createFixture([autoProfile]);
  const result = await mod.requireExecutableStrategy(1, 'STANDARD', 'BINANCE', 'DEMO', 'AUTOMATIC');
  assert.equal(result.execution_mode, 'AUTOMATIC');
  assert.equal(result.auto_execution_enabled, true);
});

test('saveStrategyProfile rejects newly enabling auto execution without confirmAutomatic', async () => {
  const existingProfile = {
    strategy: 'STANDARD',
    enabled: true,
    emergency_stop_enabled: false,
    auto_execution_enabled: false,
  };
  const mod = createFixture([existingProfile]);
  const input = {
    strategy: 'STANDARD',
    exchange: 'BINANCE',
    environment: 'DEMO',
    enabled: true,
    execution_mode: 'AUTOMATIC',
    risk_percentage: '1.0',
    order_size_mode: 'RISK_BASED',
    fixed_notional_usdt: '100',
    leverage: 15,
    max_open_positions: 10,
    max_daily_loss_percent: '5.0',
    auto_execution_enabled: true,
    emergency_stop_enabled: false,
  };
  await assert.rejects(
    () => mod.saveStrategyProfile(1, input, { confirmEnable: true, confirmAutomatic: false, confirmEmergencyStopReset: false }),
    (err) => err.status === 422 && /Explicit confirmation is required to enable automatic Demo execution/i.test(err.message),
  );
});

test('saveStrategyProfile allows updating settings on existing auto-enabled strategy without repeatedly throwing 422', async () => {
  const existingProfile = {
    strategy: 'STANDARD',
    enabled: true,
    emergency_stop_enabled: false,
    auto_execution_enabled: true,
  };
  const mod = createFixture([existingProfile]);
  const input = {
    strategy: 'STANDARD',
    exchange: 'BINANCE',
    environment: 'DEMO',
    enabled: true,
    execution_mode: 'AUTOMATIC',
    risk_percentage: '1.5',
    order_size_mode: 'RISK_BASED',
    fixed_notional_usdt: '100',
    leverage: 20,
    max_open_positions: 10,
    max_daily_loss_percent: '5.0',
    auto_execution_enabled: true,
    emergency_stop_enabled: false,
  };
  // Should succeed even if confirmAutomatic is false because it was already authorized
  await mod.saveStrategyProfile(1, input, { confirmEnable: true, confirmAutomatic: false, confirmEmergencyStopReset: false });
  const lastInserted = mod.getLastInserted();
  assert.equal(lastInserted.params[13], 20); // leverage 20x saved
});
