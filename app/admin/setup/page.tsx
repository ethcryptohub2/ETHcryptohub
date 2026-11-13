import Link from 'next/link';
import { currentUser } from '../../../lib/auth';
import { AdminSetupForm } from './setup-form';

export const dynamic = 'force-dynamic';
export default async function AdminSetupPage() {
  const setupConfigured = (process.env.ADMIN_SETUP_TOKEN?.length ?? 0) >= 32;
  const user = await currentUser();
  return <main className="card auth"><Link className="brand" href="/">ETHCRYPTOHUB</Link><h1>One-time admin setup</h1><p className="muted">Set a private ADMIN_SETUP_TOKEN of at least 32 characters in the deployment environment, then enter it here. This route closes after the first administrator is assigned. Remove the token from the environment after setup.</p>{!user ? <p className="error">Sign in with a Supabase-verified account before initial administrator setup. <Link href="/login">Sign in</Link></p> : setupConfigured ? <AdminSetupForm email={user.email} /> : <p className="error">Administrator setup is not enabled. Add ADMIN_SETUP_TOKEN in the private deployment environment, then redeploy.</p>}</main>;
}
