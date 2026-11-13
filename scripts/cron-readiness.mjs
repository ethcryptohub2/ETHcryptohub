function parseHttpsOrigin(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    ) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function inspectCronReadiness(env) {
  const enabledValue = env.SMARTEXIT_CRON_RECONCILIATION_ENABLED?.trim().toLowerCase();
  const secretConfigured = (env.CRON_SECRET?.length ?? 0) >= 32;
  if (enabledValue !== 'true') {
    const flagValid = enabledValue === undefined || enabledValue === '' || enabledValue === 'false';
    return {
      status: flagValid ? 'DISABLED' : 'INVALID',
      enabled: false,
      authorizationConfigured: secretConfigured,
      targetVerified: false,
      errors: flagValid ? [] : ['SMARTEXIT_CRON_RECONCILIATION_ENABLED must be unset, false, or true.'],
    };
  }

  const errors = [];
  if (env.VERCEL_ENV !== 'preview' && env.SMARTEXIT_DEPLOYMENT_ENV !== 'staging') {
    errors.push('Protection reconciliation may only be enabled for the verified Staging Preview environment.');
  }
  if (env.SMARTEXIT_CRON_TARGET_ENVIRONMENT?.trim().toLowerCase() !== 'staging') {
    errors.push('SMARTEXIT_CRON_TARGET_ENVIRONMENT must be staging.');
  }
  if (!secretConfigured) errors.push('CRON_SECRET must be configured with at least 32 characters.');

  const configuredOrigin = parseHttpsOrigin(env.SMARTEXIT_CRON_BASE_URL ?? '');
  const approvedOrigin = parseHttpsOrigin(env.SMARTEXIT_STAGING_PREVIEW_URL ?? '');
  if (!configuredOrigin || !approvedOrigin || configuredOrigin !== approvedOrigin) {
    errors.push('CRON target must exactly match the approved HTTPS Staging Preview origin.');
  }

  const productionOrigin = parseHttpsOrigin(env.SMARTEXIT_PRODUCTION_APP_URL ?? '');
  if (!productionOrigin) {
    errors.push('SMARTEXIT_PRODUCTION_APP_URL must identify the approved Production origin before enabling CRON.');
  }
  if (productionOrigin && configuredOrigin && configuredOrigin === productionOrigin) {
    errors.push('CRON target must not match the Production origin.');
  }

  return {
    status: errors.length === 0 ? 'READY' : 'BLOCKED',
    enabled: errors.length === 0,
    authorizationConfigured: secretConfigured,
    targetVerified: errors.length === 0,
    errors,
  };
}
