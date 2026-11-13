import { AuthForm } from '../auth-form';
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ email?: string; code?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="verify" initialEmail={params.email ?? ''} />;
}
