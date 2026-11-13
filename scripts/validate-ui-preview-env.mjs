import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUiPreviewSources, validateUiPreviewEnvironment } from './ui-preview-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const sources = await loadUiPreviewSources(root);
  const report = validateUiPreviewEnvironment(process.env, sources);
  console.log(`Environment: ${report.classification}`);
  console.log(`Validation path: ${report.mode}`);
  for (const [name, passed] of Object.entries(report.checks)) {
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  }
  console.log(report.message);
  if (!report.valid) {
    for (const error of report.errors) console.error(error);
    process.exitCode = 1;
  }
} catch {
  console.error('UI Preview preflight failed: required application source could not be inspected.');
  process.exitCode = 1;
}
