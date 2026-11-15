export type AdminDemoEnvironment = Record<string, string | undefined>;

function publicProjectReference(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function databaseProjectReference(env: AdminDemoEnvironment) {
  const connectionString = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (connectionString) {
    try {
      const url = new URL(connectionString);
      const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (direct) return direct[1]!.toLowerCase();
      return /^postgres\.([a-z0-9-]+)$/i.exec(decodeURIComponent(url.username))?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
  const host = env.SUPABASE_DB_HOST?.trim() ?? '';
  const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host);
  if (direct) return direct[1]!.toLowerCase();
  return /^postgres\.([a-z0-9-]+)$/i.exec(env.SUPABASE_DB_USER?.trim() ?? '')?.[1]?.toLowerCase() ?? null;
}

export function isApprovedAdminDemoStagingTarget(env: AdminDemoEnvironment) {
  const stagingRef = env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? '';
  const productionRef = env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? '';
  const vercelEnvironment = env.VERCEL_ENV?.trim().toLowerCase();
  const explicitlyStaging = env.SMARTEXIT_DEPLOYMENT_ENV?.trim().toLowerCase() === 'staging';
  const classifiedAsPreview =
    vercelEnvironment !== 'production' &&
    (vercelEnvironment === 'preview' || explicitlyStaging);
  return Boolean(
    classifiedAsPreview &&
    /^[a-z0-9-]+$/.test(stagingRef) &&
    /^[a-z0-9-]+$/.test(productionRef) &&
    stagingRef !== productionRef &&
    publicProjectReference(env.NEXT_PUBLIC_SUPABASE_URL) === stagingRef &&
    databaseProjectReference(env) === stagingRef,
  );
}
