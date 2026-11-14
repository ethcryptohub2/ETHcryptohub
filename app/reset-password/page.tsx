import { AuthForm } from '../auth-form';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; code?: string }>;
}) {
  const params = await searchParams;
  return <AuthForm mode="reset" initialEmail={params.email ?? ''} initialCode={params.code ?? ''} />;
}
