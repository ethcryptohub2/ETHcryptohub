import { AuthForm } from '../auth-form';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; email?: string; code?: string; authError?: string }> }) {
  const params = await searchParams;
  if (params.code) {
    return <AuthForm mode="verify" initialEmail={params.email ?? ''} initialError="This legacy verification link is no longer valid. Request a Supabase confirmation link." />;
  }
  const initialError = params.authError === 'account_unavailable'
    ? 'This account is unavailable or could not be linked. Contact support.'
    : params.authError
      ? 'This confirmation or recovery link is invalid or expired. Request a new link.'
      : '';
  return <AuthForm mode="login" initialEmail={params.email ?? ''} initialError={initialError} emailVerified={params.verified === '1'} />;
}
