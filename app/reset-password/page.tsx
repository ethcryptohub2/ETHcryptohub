import { redirect } from 'next/navigation';
import { AuthForm } from '../auth-form';
import { currentUser } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage() {
  if (!(await currentUser())) redirect('/forgot-password');
  return <AuthForm mode="reset-password" />;
}
