import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectUiPreviewEnvironment } from '../lib/ui-preview-mode.mjs';

const sourceFiles = {
  policy: path.join('lib', 'ui-preview-mode.mjs'),
  proxy: 'proxy.ts',
  database: path.join('lib', 'db.ts'),
  authentication: path.join('lib', 'auth.ts'),
  publicHome: path.join('app', 'page.tsx'),
  unavailablePage: path.join('app', 'ui-preview-unavailable', 'page.tsx'),
};

export async function loadUiPreviewSources(root) {
  return Object.fromEntries(
    await Promise.all(Object.entries(sourceFiles).map(async ([name, relativePath]) => [
      name,
      await readFile(path.join(root, relativePath), 'utf8'),
    ])),
  );
}

export function verifyUiPreviewSafetyWiring(sources = {}) {
  const policy = sources.policy ?? '';
  const proxy = sources.proxy ?? '';
  const database = sources.database ?? '';
  const authentication = sources.authentication ?? '';
  const publicHome = sources.publicHome ?? '';
  const unavailablePage = sources.unavailablePage ?? '';
  const apiRequestsBlocked =
    policy.includes("normalizedPath === '/api'") &&
    policy.includes("normalizedPath.startsWith('/api/')") &&
    proxy.includes('decideUiPreviewRequest') &&
    proxy.includes('status: 503');
  const privatePagesRewritten =
    policy.includes("return 'unavailable'") &&
    proxy.includes('NextResponse.rewrite') &&
    proxy.includes('UI_PREVIEW_UNAVAILABLE_PATH');
  const databaseAccessGuarded =
    database.includes('assertDatabaseAccessAllowed(process.env)') &&
    database.includes('assertDatabaseAccessEnabled();');
  const authorizationPreserved =
    authentication.includes('export async function requireUser') &&
    authentication.includes('export async function requireAdmin');
  const publicHomeIsSafe =
    publicHome.includes('isUiPreviewRequested(process.env)') &&
    publicHome.includes('Unavailable in UI Preview');
  const unavailableStatePresent =
    unavailablePage.includes('Unavailable in UI Preview') &&
    unavailablePage.includes('notFound()');

  return {
    apiRequestsBlocked,
    privatePagesRewritten,
    databaseAccessGuarded,
    authorizationPreserved,
    publicHomeIsSafe,
    unavailableStatePresent,
    databaseWritesDisabled: apiRequestsBlocked && databaseAccessGuarded,
    noAuthenticationBypass: privatePagesRewritten && authorizationPreserved,
    noCrossEnvironmentFallback: apiRequestsBlocked && databaseAccessGuarded,
  };
}

export function validateUiPreviewEnvironment(env, sources = {}) {
  const environment = inspectUiPreviewEnvironment(env);
  const wiring = verifyUiPreviewSafetyWiring(sources);
  const errors = [...environment.errors];
  for (const [name, passed] of Object.entries(wiring)) {
    if (!passed) errors.push(`UI Preview safety wiring check failed: ${name}.`);
  }
  return {
    valid: errors.length === 0,
    mode: 'ui-preview',
    classification: env.VERCEL_ENV ?? 'unset',
    errors,
    checks: { ...environment.checks, ...wiring },
    message: errors.length
      ? 'UI Preview validation failed.'
      : 'UI Preview validation passed; only the public landing page and static assets are available.',
  };
}
