export function isStagingDemoTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  const deploymentEnv = env.SMARTEXIT_DEPLOYMENT_ENV?.trim().toLowerCase();
  const isStaging = vercelEnv === 'preview' || deploymentEnv === 'staging';
  return Boolean(isStaging && env.NEXT_PUBLIC_SUPABASE_URL?.includes('ghecpkpaxbrvehquhzkr'));
}

function isApprovedForEnvironment(
  explicitFlag: string,
  environment: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (isStagingDemoTarget(env)) {
    return environment === 'DEMO';
  }
  return env[explicitFlag] === 'true';
}

export function isBinanceCredentialStorageAllowed(
  environment: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isApprovedForEnvironment('SMARTEXIT_BINANCE_CREDENTIAL_STORAGE_ENABLED', environment, env);
}

export function isBinanceSignedReadAllowed(
  environment: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isApprovedForEnvironment('SMARTEXIT_BINANCE_CREDENTIAL_TESTS_ENABLED', environment, env);
}

export function isBinanceBalanceReadAllowed(
  environment: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isApprovedForEnvironment('SMARTEXIT_BINANCE_BALANCE_READ_ENABLED', environment, env);
}
