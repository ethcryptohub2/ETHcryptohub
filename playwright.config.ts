import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'smartexit-auth-e2e-results'),
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.SMARTEXIT_TEST_BASE_URL,
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
