import { AuthForm } from '../auth-form';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; email?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="login" initialEmail={params.email ?? ''} emailVerified={params.verified === '1'} />;
}
