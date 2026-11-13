import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUiPreviewFlagStatus } from '../lib/ui-preview-mode.mjs';
import { loadUiPreviewSources } from './ui-preview-environment.mjs';
import { validateConfiguredDeploymentEnvironment } from './deployment-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const flagStatus = getUiPreviewFlagStatus(process.env);
  const binanceSource = flagStatus === 'disabled'
    ? await readFile(path.join(root, 'lib', 'binance-futures.ts'), 'utf8')
    : '';
  const uiPreviewSources = flagStatus === 'enabled'
    ? await loadUiPreviewSources(root)
    : {};
  const report = validateConfiguredDeploymentEnvironment(process.env, binanceSource, uiPreviewSources);
  console.log(`Environment: ${report.classification}`);
  console.log(`Validation path: ${report.mode}`);
  for (const [name, passed] of Object.entries(report.checks)) {
    if (typeof passed === 'boolean') console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  }
  console.log(report.message);
  if (report.checks.cronReconciliationStatus) {
    console.log(`Binance protection CRON: ${report.checks.cronReconciliationStatus}`);
  }
  if (!report.valid) {
    for (const error of report.errors) console.error(error);
    process.exitCode = 1;
  }
} catch {
  console.error('Deployment preflight failed: required application source could not be inspected.');
  process.exitCode = 1;
}
