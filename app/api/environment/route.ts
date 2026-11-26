export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractPublicRef(urlStr?: string): string | null {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function extractDatabaseRef(env: NodeJS.ProcessEnv): string | null {
  const conn = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (conn) {
    try {
      const url = new URL(conn);
      const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (direct) return direct[1].toLowerCase();
      const user = decodeURIComponent(url.username);
      const pooler = /^postgres\.([a-z0-9-]+)$/i.exec(user);
      return pooler?.[1]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  const host = env.SUPABASE_DB_HOST?.trim() ?? '';
  const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host);
  if (direct) return direct[1].toLowerCase();
  const poolerUser = /^postgres\.([a-z0-9-]+)$/i.exec(env.SUPABASE_DB_USER?.trim() ?? '');
  return poolerUser?.[1]?.toLowerCase() ?? null;
}

export async function GET() {
  const env = process.env;
  const vercelEnv = env.VERCEL_ENV?.trim().toLowerCase();
  const deploymentEnv = env.SMARTEXIT_DEPLOYMENT_ENV?.trim().toLowerCase();
  const stagingExpectedRef = env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF?.trim().toLowerCase() || 'ghecpkpaxbrvehquhzkr';
  const prodExpectedRef = env.SMARTEXIT_PRODUCTION_SUPABASE_PROJECT_REF?.trim().toLowerCase() || 'kafsdnzzjawikoavkhvm';

  const publicRef = extractPublicRef(env.NEXT_PUBLIC_SUPABASE_URL);
  const dbRef = extractDatabaseRef(env);

  // Safety Gate: If database and public references are both present, they MUST match.
  if (publicRef && dbRef && publicRef !== dbRef) {
    return Response.json(
      {
        ok: false,
        status: 'FAILED_CLOSED',
        label: 'Config Inconsistent (Fail-Closed)',
        error: `Supabase public ref (${publicRef}) does not match DB ref (${dbRef}).`,
        publicRef,
        dbRef,
      },
      { status: 500 },
    );
  }

  const activeRef = dbRef || publicRef;

  // Staging / Preview Classification
  const isPreview = vercelEnv === 'preview' || deploymentEnv === 'staging';
  if (isPreview) {
    // Staging must NEVER point to Production
    if (activeRef === prodExpectedRef) {
      return Response.json(
        {
          ok: false,
          status: 'FAILED_CLOSED',
          label: 'Config Inconsistent (Fail-Closed)',
          error: 'Preview environment is dangerously targeting Production database!',
        },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      status: 'STAGING',
      label: 'Staging · Sydney',
      projectRef: activeRef || stagingExpectedRef,
      region: 'ap-southeast-2',
      hosting: env.RENDER ? 'Render Staging' : (vercelEnv ? 'Vercel Preview' : 'Staging'),
      liveTradingEnabled: false,
    });
  }

  // Production Classification
  const isProduction = vercelEnv === 'production' || deploymentEnv === 'production';
  if (isProduction) {
    // Production should target Production Supabase
    if (activeRef && activeRef !== prodExpectedRef) {
      return Response.json(
        {
          ok: false,
          status: 'FAILED_CLOSED',
          label: 'Config Inconsistent (Fail-Closed)',
          error: `Production environment expected ${prodExpectedRef} but detected ${activeRef}.`,
        },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      status: 'PRODUCTION',
      label: 'Production · Mumbai',
      projectRef: activeRef || prodExpectedRef,
      region: 'ap-south-1',
      hosting: 'Vercel Production',
      liveTradingEnabled: false,
    });
  }

  // Local / Development Environment
  return Response.json({
    ok: true,
    status: 'LOCAL',
    label: 'Development · Local',
    projectRef: activeRef || 'local',
    region: 'local',
    hosting: 'Localhost',
    liveTradingEnabled: false,
  });
}
