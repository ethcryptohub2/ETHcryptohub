export const UI_PREVIEW_PROJECT_ID = 'prj_RMBw9wXVJexXUMBGSMYScXNFkatL';
export const UI_PREVIEW_UNAVAILABLE_PATH = '/ui-preview-unavailable';

const DATABASE_VARIABLE_PATTERN =
  /^(?:DATABASE_URL(?:_UNPOOLED)?|POSTGRES(?:_.*)?|PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE)|SUPABASE_.*|NEXT_PUBLIC_SUPABASE_.*)$/i;
const PRIVATE_CREDENTIAL_PATTERN =
  /^(?:AUTH_SECRET|CRON_SECRET|ADMIN_SETUP_TOKEN|BINANCE_CREDENTIALS_KEY|RESEND_API_KEY|GMAIL_APP_PASSWORD|VAPID_PRIVATE_KEY|VERCEL_AUTOMATION_BYPASS_SECRET|.*(?:_ACCESS_KEY_ID|_ACCESS_KEY|_API_KEY|_API_SECRET|_CLIENT_SECRET|_SECRET|_TOKEN|_PASSWORD|_PASS|_PRIVATE_KEY|_CREDENTIALS_KEY|_SERVICE_ROLE_KEY|_PASSPHRASE))$/i;
const SIGNING_OR_EXCHANGE_CREDENTIAL_PATTERN =
  /^(?:SUPABASE_.*(?:KEY|SECRET|PASSWORD|TOKEN)|NEXT_PUBLIC_SUPABASE_.*(?:KEY|TOKEN)|(?:BINANCE|BYBIT|OKX|BITGET|GATE(?:IO)?)_.*(?:API_KEY|API_SECRET|CREDENTIALS_KEY|PASSPHRASE|PRIVATE_KEY|TOKEN))$/i;
const EXECUTION_GATES = [
  'BINANCE_FUTURES_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_VERIFIED',
  'BINANCE_FUTURES_LIVE_TRADING_APPROVED',
  'BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED',
];

export function getUiPreviewFlagStatus(env = {}) {
  const raw = env.SMARTEXIT_UI_PREVIEW_ONLY;
  if (typeof raw !== 'string' || raw.trim() === '') return 'disabled';
  const value = raw.trim().toLowerCase();
  if (value === 'true') return 'enabled';
  if (value === 'false') return 'disabled';
  return 'invalid';
}

export function isUiPreviewRequested(env = {}) {
  return getUiPreviewFlagStatus(env) === 'enabled';
}

export function assertDatabaseAccessAllowed(env = {}) {
  if (getUiPreviewFlagStatus(env) !== 'disabled') {
    const error = new Error('Database access is disabled in UI Preview.');
    error.name = 'UiPreviewDatabaseAccessError';
    throw error;
  }
}

function isDisabled(value) {
  return value == null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'false';
}

function configuredNames(env, pattern) {
  return Object.keys(env).filter((name) =>
    pattern.test(name) && typeof env[name] === 'string' && env[name].trim() !== '',
  );
}

function isPreviewScopedVercelOidcToken(token) {
  if (typeof token !== 'string' || token.trim() === '') return true;

  try {
    const segments = token.trim().split('.');
    if (segments.length !== 3 || !segments[1]) return false;
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(paddedPayload), (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    const subject = 'owner:eth-cryptohub:project:cryptohub:environment:preview';

    return (
      ['https://oidc.vercel.com/eth-cryptohub', 'https://oidc.vercel.com'].includes(claims.iss) &&
      claims.aud === 'https://vercel.com/eth-cryptohub' &&
      claims.sub === subject &&
      (!claims.scope || claims.scope === subject) &&
      claims.owner === 'eth-cryptohub' &&
      claims.project === 'cryptohub' &&
      claims.project_id === UI_PREVIEW_PROJECT_ID &&
      claims.environment === 'preview'
    );
  } catch {
    return false;
  }
}

function vercelHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const candidate = value.trim().startsWith('https://') ? value.trim() : `https://${value.trim()}`;
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash ||
      !url.hostname.toLowerCase().endsWith('.vercel.app')
    ) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function inspectUiPreviewEnvironment(env = {}) {
  const errors = [];
  const flagStatus = getUiPreviewFlagStatus(env);
  const selectedBranch = typeof env.SMARTEXIT_UI_PREVIEW_BRANCH === 'string'
    ? env.SMARTEXIT_UI_PREVIEW_BRANCH.trim()
    : '';
  const deployedBranch = typeof env.VERCEL_GIT_COMMIT_REF === 'string'
    ? env.VERCEL_GIT_COMMIT_REF.trim()
    : '';
  const defaultBranch = typeof env.VERCEL_GIT_REPO_DEFAULT_BRANCH === 'string'
    ? env.VERCEL_GIT_REPO_DEFAULT_BRANCH.trim()
    : '';
  const previewHost = vercelHost(env.VERCEL_URL);
  const productionHost = vercelHost(env.VERCEL_PROJECT_PRODUCTION_URL);
  const databaseVariables = configuredNames(env, DATABASE_VARIABLE_PATTERN);
  const credentialVariables = configuredNames(env, PRIVATE_CREDENTIAL_PATTERN)
    .filter((name) => name !== 'VERCEL_OIDC_TOKEN')
    .concat(configuredNames(env, SIGNING_OR_EXCHANGE_CREDENTIAL_PATTERN));
  const platformOidcTokenPreviewScoped = isPreviewScopedVercelOidcToken(env.VERCEL_OIDC_TOKEN);
  const tradingDisabled = EXECUTION_GATES.every((name) => isDisabled(env[name]));
  const cronDisabled = isDisabled(env.SMARTEXIT_CRON_RECONCILIATION_ENABLED);
  const branchIsSelected = Boolean(
    selectedBranch &&
    deployedBranch &&
    selectedBranch === deployedBranch &&
    !['main', 'master'].includes(selectedBranch.toLowerCase()) &&
    (!defaultBranch || selectedBranch.toLowerCase() !== defaultBranch.toLowerCase()) &&
    !String(env.VERCEL_GIT_PULL_REQUEST_ID ?? '').trim(),
  );
  const previewUrlIsVerified = Boolean(previewHost && (!productionHost || previewHost !== productionHost));

  if (flagStatus === 'invalid') {
    errors.push('SMARTEXIT_UI_PREVIEW_ONLY must be unset, false, or true.');
  } else if (flagStatus !== 'enabled') {
    errors.push('SMARTEXIT_UI_PREVIEW_ONLY must be explicitly true for this validation path.');
  }
  if (env.VERCEL_ENV === 'production') {
    errors.push('UI Preview mode is forbidden in Production.');
  } else if (env.VERCEL_ENV !== 'preview') {
    errors.push('UI Preview mode requires VERCEL_ENV=preview.');
  }
  if (env.VERCEL_PROJECT_ID !== UI_PREVIEW_PROJECT_ID) {
    errors.push('UI Preview mode requires the approved Vercel project ID.');
  }
  if (!branchIsSelected) {
    errors.push('The selected Preview branch must exactly match VERCEL_GIT_COMMIT_REF and must not be the production or pull-request branch.');
  }
  if (!previewUrlIsVerified) {
    errors.push('VERCEL_URL must identify a distinct Vercel Preview deployment.');
  }
  if (!tradingDisabled) {
    errors.push('Trading and remote Demo authorization gates must be unset or false.');
  }
  if (!cronDisabled) {
    errors.push('SMARTEXIT_CRON_RECONCILIATION_ENABLED must be unset or false in UI Preview.');
  }
  if (databaseVariables.length) {
    errors.push(`Database and Supabase connection variables must be absent in UI Preview: ${databaseVariables.join(', ')}.`);
  }
  if (credentialVariables.length) {
    errors.push(`Private credential variables must be absent in UI Preview: ${[...new Set(credentialVariables)].join(', ')}.`);
  }
  if (!platformOidcTokenPreviewScoped) {
    errors.push('The Vercel OIDC token, when present, must be scoped to the approved Preview project and environment.');
  }

  return {
    valid: errors.length === 0,
    errors,
    checks: {
      modeExplicitlyEnabled: flagStatus === 'enabled',
      productionModeRejected: env.VERCEL_ENV !== 'production',
      previewEnvironment: env.VERCEL_ENV === 'preview',
      correctVercelProject: env.VERCEL_PROJECT_ID === UI_PREVIEW_PROJECT_ID,
      selectedPreviewBranch: branchIsSelected,
      previewUrlIsVerified,
      tradingDisabled,
      cronDisabled,
      databaseVariablesAbsent: databaseVariables.length === 0,
      privateCredentialsAbsent: credentialVariables.length === 0,
      platformOidcTokenPreviewScoped,
    },
  };
}

export function decideUiPreviewRequest(env, pathname, method) {
  const flagStatus = getUiPreviewFlagStatus(env);
  if (flagStatus === 'disabled') return 'next';
  if (flagStatus === 'invalid' || !inspectUiPreviewEnvironment(env).valid) return 'reject';
  if (method !== 'GET' && method !== 'HEAD') return 'reject';

  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath === '/api' || normalizedPath.startsWith('/api/')) return 'reject';
  if (normalizedPath === '/service-worker.js' || normalizedPath.startsWith('/_next/image')) return 'reject';
  if (
    normalizedPath === '/' ||
    normalizedPath === UI_PREVIEW_UNAVAILABLE_PATH ||
    normalizedPath.startsWith('/_next/static/') ||
    ['/favicon.ico', '/icon.svg', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml'].includes(normalizedPath)
  ) return 'next';
  return 'unavailable';
}
