import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['pg'],
  outputFileTracingIncludes: {
    '/*': ['./supabase/migrations/*.sql'],
  },
  agentRules: false,
};

export default nextConfig;
