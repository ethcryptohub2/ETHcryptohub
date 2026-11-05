import { AuthForm } from '../auth-form';
export default async function ResendVerificationPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="resend" initialEmail={params.email ?? ''} />;
}
