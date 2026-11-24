import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from './route.ts';

test('environment route returns LOCAL when unconfigured', async () => {
  const originalEnv = { ...process.env };
  try {
    delete process.env.VERCEL_ENV;
    delete process.env.SMARTEXIT_DEPLOYMENT_ENV;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'LOCAL');
    assert.equal(body.label, 'Development · Local');
  } finally {
    process.env = originalEnv;
  }
});

test('environment route fails closed when public and db project refs mismatch', async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ghecpkpaxbrvehquhzkr.supabase.co';
    process.env.SUPABASE_DB_HOST = 'aws-0-ap-south-1.pooler.supabase.com';
    process.env.SUPABASE_DB_USER = 'postgres.kafsdnzzjawikoavkhvm';
    const res = await GET();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.status, 'FAILED_CLOSED');
    assert.match(body.error, /does not match/);
  } finally {
    process.env = originalEnv;
  }
});

test('environment route confirms STAGING when preview and matching staging ref', async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.VERCEL_ENV = 'preview';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ghecpkpaxbrvehquhzkr.supabase.co';
    process.env.SUPABASE_DB_USER = 'postgres.ghecpkpaxbrvehquhzkr';
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'STAGING');
    assert.equal(body.label, 'Staging · Sydney');
    assert.equal(body.region, 'ap-southeast-2');
  } finally {
    process.env = originalEnv;
  }
});

test('environment route blocks preview targeting production ref', async () => {
  const originalEnv = { ...process.env };
  try {
    process.env.VERCEL_ENV = 'preview';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://kafsdnzzjawikoavkhvm.supabase.co';
    process.env.SUPABASE_DB_USER = 'postgres.kafsdnzzjawikoavkhvm';
    const res = await GET();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.status, 'FAILED_CLOSED');
    assert.match(body.error, /dangerously targeting Production/);
  } finally {
    process.env = originalEnv;
  }
});
