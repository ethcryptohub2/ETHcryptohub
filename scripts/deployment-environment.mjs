import { createHash } from 'node:crypto';
import { inspectCronReadiness } from './cron-readiness.mjs';
import { getUiPreviewFlagStatus } from '../lib/ui-preview-mode.mjs';
import { validateUiPreviewEnvironment } from './ui-preview-environment.mjs';

const DEMO_ENDPOINT = 'https://demo-fapi.binance.com';
const requiredVariables = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'AUTH_SECRET',
  'BINANCE_CREDENTIALS_KEY',
  'CRON_SECRET',
];
const executionGates = [
  'BINANCE_FUTURES_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_TRADING_ENABLED',
  'BINANCE_FUTURES_DEMO_VERIFIED',
  'BINANCE_FUTURES_LIVE_TRADING_APPROVED',
];

function isDisabled(value) {
  return value === undefined || value === null || value.trim() === '' || value.trim().toLowerCase() === 'false';
}

function classifyEnvironment(env) {
  if (env.VERCEL_ENV === 'production') return 'production';
  if (env.VERCEL_ENV === 'preview') return 'preview';
  if (env.SMARTEXIT_DEPLOYMENT_ENV === 'staging') return 'staging';
  return 'local';
}

function projectRefFromSupabaseUrl(value) {
  try {
    const url = new URL(value);
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function projectRefFromDatabase(env) {
  const connectionString = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      const directHost = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (directHost) return directHost[1].toLowerCase();
      const user = decodeURIComponent(url.username);
      const poolerUser = /^postgres\.([a-z0-9-]+)$/i.exec(user);
      return poolerUser?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  const host = env.SUPABASE_DB_HOST?.trim() ?? '';
  const directHost = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host);
  if (directHost) return directHost[1].toLowerCase();
  const poolerUser = /^postgres\.([a-z0-9-]+)$/i.exec(env.SUPABASE_DB_USER?.trim() ?? '');
  return poolerUser?.[1]?.toLowerCase() ?? null;
}

function keyFingerprint(value) {
  if (!/^[a-f0-9]{64}$/i.test(value ?? '')) return null;
  return createHash('sha256').update(Buffer.from(value, 'hex')).digest('hex');
}

export function verifyBinanceEndpointSource(source) {
  const demoPinned = /DEMO:\s*'https:\/\/demo-fapi\.binance\.com'/.test(source);
  const livePinned = /LIVE:\s*'https:\/\/fapi\.binance\.com'/.test(source);
  const validatedBeforeSelection =
    /if\s*\(!isTradingEnvironment\(environment\)\)\s*throw/.test(source) &&
    /const baseUrl = environmentUrls\[environment\];/.test(source);
  return {
    valid: demoPinned && livePinned && validatedBeforeSelection,
    demoPinned,
    livePinned,
    validatedBeforeSelection,
  };
}

export function validateDeploymentEnvironment(env, binanceSource = '') {
  const classification = classifyEnvironment(env);
  const errors = [];
  const checks = {
    classification,
    databaseProjectMatches: null,
    publicProjectMatches: null,
    productionAndStagingDiffer: null,
    encryptionKeyIsStagingSpecific: null,
    executionGatesDisabled: null,
    demoEndpointPinnedWithoutFallback: null,
    cronAuthorizationConfigured: null,
    cronReconciliationStatus: null,
    cronTargetVerified: null,
  };

  if (classification === 'local') {
    return { valid: true, classification, errors, checks, message: 'Local environment; deployment checks were not required.' };
  }

  const isPreviewOrStaging = classification === 'preview' || classification === 'staging';
  for (const name of requiredVariables) {
    if (!env[name]?.trim()) errors.push(`Required configuration is missing: ${name}.`);
  }

  const hasDatabaseUrl = Boolean((env.SUPABASE_DB_URL ?? env.DATABASE_URL)?.trim());
  const hasDatabaseFields = Boolean(
    env.SUPABASE_DB_HOST?.trim() &&
    env.SUPABASE_DB_USER?.trim() &&
    env.SUPABASE_DB_PASSWORD,
  );
  if (!hasDatabaseUrl && !hasDatabaseFields) {
    errors.push('Configure a server-side PostgreSQL URL or the required host, user, and password variables.');
  }

  if (!/^[a-f0-9]{64}$/i.test(env.BINANCE_CREDENTIALS_KEY ?? '')) {
    errors.push('BINANCE_CREDENTIALS_KEY must be configured as 32 bytes encoded in 64 hexadecimal characters.');
  }
  if ((env.AUTH_SECRET?.length ?? 0) < 32) errors.push('AUTH_SECRET must contain at least 32 characters.');
  if ((env.CRON_SECRET?.length ?? 0) < 32) errors.push('CRON_SECRET must contain at least 32 characters.');

  const productionRef = env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9-]+$/.test(productionRef)) {
    errors.push('SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF must identify the approved Production project.');
  }
  const publicRef = projectRefFromSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const dbRef = projectRefFromDatabase(env);
  const expectedRef = classification === 'production'
    ? productionRef
    : env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? '';

  if (isPreviewOrStaging && !/^[a-z0-9-]+$/.test(expectedRef)) {
    errors.push('SMARTEXIT_STAGING_SUPABASE_PROJECT_REF must identify the approved Staging project.');
  }
  checks.publicProjectMatches = Boolean(expectedRef && publicRef === expectedRef);
  checks.databaseProjectMatches = Boolean(expectedRef && dbRef === expectedRef);
  if (!checks.publicProjectMatches) {
    errors.push('The Supabase public URL does not match the approved project reference.');
  }
  if (!checks.databaseProjectMatches) {
    errors.push('The database target could not be verified as the approved Supabase project.');
  }

  if (isPreviewOrStaging) {
    checks.productionAndStagingDiffer = Boolean(expectedRef && productionRef && expectedRef !== productionRef);
    if (!checks.productionAndStagingDiffer) {
      errors.push('Staging and Production project references must both be known and different.');
    }

    const productionFingerprint = env.SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256?.trim().toLowerCase() ?? '';
    const currentFingerprint = keyFingerprint(env.BINANCE_CREDENTIALS_KEY ?? '');
    checks.encryptionKeyIsStagingSpecific = Boolean(
      /^[a-f0-9]{64}$/.test(productionFingerprint) &&
      currentFingerprint &&
      currentFingerprint !== productionFingerprint,
    );
    if (!checks.encryptionKeyIsStagingSpecific) {
      errors.push('Staging requires a distinct credential-encryption key from the configured Production key fingerprint.');
    }
  }

  const invalidGates = executionGates.filter((name) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && value !== '' && value !== 'false';
  });
  if (!isDisabled(env.BINANCE_DEMO_REMOTE_TESTS_AUTHORIZED)) {
    errors.push('Remote Demo test authorization must not persist in a deployment environment.');
  }
  checks.executionGatesDisabled = invalidGates.length === 0;
  if (invalidGates.length) errors.push(`Trading gates must remain unset or false: ${invalidGates.join(', ')}.`);

  if (env.BINANCE_FUTURES_DEMO_API_URL && env.BINANCE_FUTURES_DEMO_API_URL !== DEMO_ENDPOINT) {
    errors.push('A non-standard Binance Demo endpoint override is not permitted.');
  }
  const cron = inspectCronReadiness(env);
  checks.cronAuthorizationConfigured = cron.authorizationConfigured;
  checks.cronReconciliationStatus = cron.status;
  checks.cronTargetVerified = cron.targetVerified;
  errors.push(...cron.errors);
  const endpointCheck = verifyBinanceEndpointSource(binanceSource);
  checks.demoEndpointPinnedWithoutFallback = endpointCheck.valid;
  if (!endpointCheck.valid) errors.push('The Binance adapter endpoint mapping or environment validation did not pass the static fail-closed check.');

  return {
    valid: errors.length === 0,
    classification,
    errors,
    checks,
    message: errors.length ? 'Deployment environment validation failed.' : 'Deployment environment validation passed.',
  };
}

export function validateConfiguredDeploymentEnvironment(env, binanceSource = '', uiPreviewSources = {}) {
  const mode = getUiPreviewFlagStatus(env);
  if (mode === 'invalid') {
    return {
      valid: false,
      mode: 'invalid',
      classification: classifyEnvironment(env),
      errors: ['SMARTEXIT_UI_PREVIEW_ONLY must be unset, false, or true.'],
      checks: {},
      message: 'Deployment environment validation failed.',
    };
  }
  if (mode === 'enabled') return validateUiPreviewEnvironment(env, uiPreviewSources);
  return {
    ...validateDeploymentEnvironment(env, binanceSource),
    mode: 'full',
  };
}
