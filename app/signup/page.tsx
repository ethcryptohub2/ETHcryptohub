import { AuthForm } from '../auth-form';
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="signup" initialEmail={params.email ?? ''} />;
}
