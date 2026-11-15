import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    authInterrupts: true,
  },
  serverExternalPackages: ['pg'],
  outputFileTracingIncludes: {
    '/*': ['./supabase/migrations/*.sql'],
  },
  agentRules: false,
};

export default nextConfig;
