import { AuthForm } from '../auth-form';

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="forgot" initialEmail={params.email ?? ''} />;
}
