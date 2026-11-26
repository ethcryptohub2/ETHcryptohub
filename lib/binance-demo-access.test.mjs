import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isBinanceBalanceReadAllowed,
  isBinanceCredentialStorageAllowed,
  isBinanceSignedReadAllowed,
  isStagingDemoTarget,
} from './binance-demo-access.ts';
import { shouldForwardToBackend } from './backend-target.ts';

test('isStagingDemoTarget matches isolated Staging Supabase on Render/Preview only', () => {
  assert.equal(isStagingDemoTarget({}), false);
  assert.equal(
    isStagingDemoTarget({
      SMARTEXIT_DEPLOYMENT_ENV: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://kafsdnzzjawikoavkhvm.supabase.co',
    }),
    false,
  );
  assert.equal(
    isStagingDemoTarget({
      SMARTEXIT_DEPLOYMENT_ENV: 'staging',
      NEXT_PUBLIC_SUPABASE_URL: 'https://ghecpkpaxbrvehquhzkr.supabase.co',
    }),
    true,
  );
  assert.equal(
    isStagingDemoTarget({
      VERCEL_ENV: 'preview',
      NEXT_PUBLIC_SUPABASE_URL: 'https://ghecpkpaxbrvehquhzkr.supabase.co',
    }),
    true,
  );
});

test('staging Demo access permits DEMO only and keeps LIVE locked even on staging', () => {
  const stagingEnv = {
    SMARTEXIT_DEPLOYMENT_ENV: 'staging',
    NEXT_PUBLIC_SUPABASE_URL: 'https://ghecpkpaxbrvehquhzkr.supabase.co',
  };
  assert.equal(isBinanceCredentialStorageAllowed('DEMO', stagingEnv), true);
  assert.equal(isBinanceSignedReadAllowed('DEMO', stagingEnv), true);
  assert.equal(isBinanceBalanceReadAllowed('DEMO', stagingEnv), true);

  assert.equal(isBinanceCredentialStorageAllowed('LIVE', stagingEnv), false);
  assert.equal(isBinanceSignedReadAllowed('LIVE', stagingEnv), false);
  assert.equal(isBinanceBalanceReadAllowed('LIVE', stagingEnv), false);
});

test('shouldForwardToBackend forwards on Render unless running inside Northflank scope', () => {
  const saved = {
    SMARTEXIT_BACKEND_URL: process.env.SMARTEXIT_BACKEND_URL,
    RENDER: process.env.RENDER,
    VERCEL: process.env.VERCEL,
    SMARTEXIT_FORCE_BACKEND_PROXY: process.env.SMARTEXIT_FORCE_BACKEND_PROXY,
    SCANNER_CIRCUIT_BREAKER_SCOPE: process.env.SCANNER_CIRCUIT_BREAKER_SCOPE,
  };
  try {
    process.env.SMARTEXIT_BACKEND_URL = 'https://site--smartexit-staging--bg8tkg2xcxv8.code.run';
    delete process.env.VERCEL;
    delete process.env.SMARTEXIT_FORCE_BACKEND_PROXY;
    delete process.env.SCANNER_CIRCUIT_BREAKER_SCOPE;
    process.env.RENDER = 'true';
    assert.equal(shouldForwardToBackend(), true);

    process.env.SCANNER_CIRCUIT_BREAKER_SCOPE = 'northflank';
    assert.equal(shouldForwardToBackend(), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
