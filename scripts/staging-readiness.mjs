import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REF_PATTERN = /^[a-z0-9-]{3,63}$/i;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

function projectReference(value) {
  const reference = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REF_PATTERN.test(reference) ? reference : null;
}

function previewOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publicProjectReference(value) {
  try {
    const url = new URL(value ?? '');
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function databaseProjectReference(env) {
  const connectionString = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (direct) return direct[1].toLowerCase();
      const pooler = /^postgres\.([a-z0-9-]+)$/i.exec(decodeURIComponent(url.username));
      return pooler?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
  const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(env.SUPABASE_DB_HOST?.trim() ?? '');
  if (direct) return direct[1].toLowerCase();
  const pooler = /^postgres\.([a-z0-9-]+)$/i.exec(env.SUPABASE_DB_USER?.trim() ?? '');
  return pooler?.[1]?.toLowerCase() ?? null;
}

function fingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

function stagingKeyFingerprint(env) {
  const supplied = fingerprint(env.SMARTEXIT_STAGING_BINANCE_CREDENTIALS_KEY_SHA256);
  const key = env.BINANCE_CREDENTIALS_KEY?.trim() ?? '';
  if (/^[a-f0-9]{64}$/i.test(key)) {
    const computed = createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex');
    return supplied && supplied !== computed ? 'MISMATCH' : computed;
  }
  return supplied;
}

export function inspectStagingReadiness(env = {}, ownerConfirmations = {}) {
  const stagingRef = projectReference(env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF);
  const productionRef = projectReference(env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF);
  const previewUrl = previewOrigin(env.SMARTEXIT_STAGING_PREVIEW_URL);
  const productionUrl = previewOrigin(env.SMARTEXIT_PRODUCTION_APP_URL);
  const publicRef = publicProjectReference(env.NEXT_PUBLIC_SUPABASE_URL);
  const dbRef = databaseProjectReference(env);
  const productionFingerprint = fingerprint(env.SMARTEXIT_PRODUCTION_BINANCE_CREDENTIALS_KEY_SHA256);
  const stagingFingerprint = stagingKeyFingerprint(env);

  let projectStatus = stagingRef ? 'SUPPLIED' : 'MISSING';
  if (stagingRef && productionRef && stagingRef === productionRef) projectStatus = 'CONFLICT';
  const publicTargetStatus = publicRef ? (publicRef === stagingRef ? 'MATCH' : 'MISMATCH') : 'MISSING';
  const databaseTargetStatus = dbRef ? (dbRef === stagingRef ? 'MATCH' : 'MISMATCH') : 'MISSING';
  let previewStatus = previewUrl ? 'SUPPLIED' : 'MISSING';
  if (previewUrl && productionUrl && previewUrl === productionUrl) previewStatus = 'CONFLICT';
  const previewEnvironmentStatus = env.VERCEL_ENV === 'preview' ? 'PREVIEW' : 'MISSING_OR_NOT_PREVIEW';
  const realtimeKeyStatus = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ? 'PRESENT' : 'MISSING';
  const verificationEmailConfigured = Boolean(
    (env.GMAIL_USER?.trim() && env.GMAIL_APP_PASSWORD?.trim()) ||
    (!env.GMAIL_USER?.trim() && !env.GMAIL_APP_PASSWORD?.trim() &&
      env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim()),
  );
  const authSecret = env.AUTH_SECRET?.trim() ?? '';
  const authSecretStatus = authSecret.length >= 32 ? 'PRESENT' : authSecret ? 'WEAK' : 'MISSING';
  const gates = [
    'BINANCE_FUTURES_TRADING_ENABLED',
    'BINANCE_FUTURES_DEMO_TRADING_ENABLED',
    'BINANCE_FUTURES_DEMO_VERIFIED',
    'BINANCE_FUTURES_LIVE_TRADING_APPROVED',
  ];
  const gatesDisabled = gates.every((name) =>
    env[name] === undefined || env[name].trim() === '' || env[name].trim().toLowerCase() === 'false',
  );
  let encryptionStatus = 'NOT_VERIFIED';
  if (stagingFingerprint === 'MISMATCH') {
    encryptionStatus = 'FINGERPRINT_MISMATCH';
  } else if (productionFingerprint && stagingFingerprint) {
    encryptionStatus = productionFingerprint === stagingFingerprint ? 'SHARED_KEY' : 'DISTINCT';
  }

  const statuses = {
    STAGING_SUPABASE_REFERENCE: projectStatus,
    PRODUCTION_SUPABASE_REFERENCE: productionRef ? 'SUPPLIED' : 'MISSING',
    VERCEL_PREVIEW_URL: previewStatus,
    VERCEL_DEPLOYMENT_ENVIRONMENT: previewEnvironmentStatus,
    STAGING_PUBLIC_DATABASE_TARGET: publicTargetStatus,
    STAGING_SERVER_DATABASE_TARGET: databaseTargetStatus,
    SUPABASE_REALTIME_PUBLIC_KEY: realtimeKeyStatus,
    AUTH_SECRET: authSecretStatus,
    AUTH_SECRET_SEPARATION: ownerConfirmations.authSecretSeparate === true
      ? 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED'
      : 'OWNER_CONFIRMATION_REQUIRED',
    VERIFICATION_EMAIL: verificationEmailConfigured ? 'CONFIGURED' : 'MISSING',
    STAGING_DATA_SANITIZATION: ownerConfirmations.stagingDataSanitized === true
      ? 'OWNER_CONFIRMED'
      : 'OWNER_CONFIRMATION_REQUIRED',
    STAGING_BACKUP_PITR: ownerConfirmations.stagingBackupPitr === true
      ? 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED'
      : 'OWNER_CONFIRMATION_REQUIRED',
    ENCRYPTION_KEY_SEPARATION: encryptionStatus,
    MIGRATION_STATUS: 'UNKNOWN',
    REMOTE_DEMO_STATUS: 'BLOCKED',
    CRON_STATUS: 'DISABLED',
    CUSTOMER_TRADING_GATES: gatesDisabled ? 'DISABLED' : 'UNEXPECTEDLY_ENABLED',
  };
  const readyForStagingReview =
    statuses.STAGING_SUPABASE_REFERENCE === 'SUPPLIED' &&
    statuses.PRODUCTION_SUPABASE_REFERENCE === 'SUPPLIED' &&
    statuses.VERCEL_PREVIEW_URL === 'SUPPLIED' &&
    statuses.VERCEL_DEPLOYMENT_ENVIRONMENT === 'PREVIEW' &&
    statuses.STAGING_PUBLIC_DATABASE_TARGET === 'MATCH' &&
    statuses.STAGING_SERVER_DATABASE_TARGET === 'MATCH' &&
    statuses.SUPABASE_REALTIME_PUBLIC_KEY === 'PRESENT' &&
    statuses.AUTH_SECRET === 'PRESENT' &&
    statuses.AUTH_SECRET_SEPARATION === 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED' &&
    statuses.VERIFICATION_EMAIL === 'CONFIGURED' &&
    statuses.CUSTOMER_TRADING_GATES === 'DISABLED' &&
    statuses.STAGING_DATA_SANITIZATION === 'OWNER_CONFIRMED' &&
    statuses.STAGING_BACKUP_PITR === 'OWNER_CONFIRMED_NOT_INDEPENDENTLY_VERIFIED' &&
    statuses.ENCRYPTION_KEY_SEPARATION === 'DISTINCT';

  return { statuses, readyForStagingReview };
}

function parseOwnerConfirmation(args, flag, envName) {
  return args.includes(flag) || envName === 'true';
}

function printReport(report) {
  console.log('Staging readiness (no database or exchange connection attempted):');
  for (const [name, status] of Object.entries(report.statuses)) console.log(`${name}: ${status}`);
  console.log(`READY_FOR_STAGING_REVIEW: ${report.readyForStagingReview ? 'YES' : 'NO'}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const report = inspectStagingReadiness(process.env, {
    stagingDataSanitized: parseOwnerConfirmation(
      args, '--owner-confirmed-sanitized', process.env.SMARTEXIT_STAGING_DATA_SANITIZATION_CONFIRMED,
    ),
    stagingBackupPitr: parseOwnerConfirmation(
      args, '--owner-confirmed-backup-pitr', process.env.SMARTEXIT_STAGING_BACKUP_PITR_OWNER_CONFIRMED,
    ),
    authSecretSeparate: parseOwnerConfirmation(
      args, '--owner-confirmed-auth-secret-separate', process.env.SMARTEXIT_STAGING_AUTH_SECRET_SEPARATE_CONFIRMED,
    ),
  });
  printReport(report);
  if (!report.readyForStagingReview) process.exitCode = 1;
}
