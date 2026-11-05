import { AuthForm } from '../auth-form';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="login" emailVerified={params.verified === '1'} />;
}
