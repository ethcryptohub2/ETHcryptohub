import { AuthForm } from '../auth-form';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; email?: string; code?: string }> }) {
  const params = await searchParams;
  if (params.code) {
    return <AuthForm mode="verify" initialEmail={params.email ?? ''} initialCode={params.code} />;
  }
  return <AuthForm mode="login" initialEmail={params.email ?? ''} emailVerified={params.verified === '1'} />;
}
