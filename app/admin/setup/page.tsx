import Link from 'next/link';
import { AdminSetupForm } from './setup-form';

export const dynamic = 'force-dynamic';
export default function AdminSetupPage() {
  const setupConfigured = (process.env.ADMIN_SETUP_TOKEN?.length ?? 0) >= 32;
  return <main className="card auth"><Link className="brand" href="/">ETHCRYPTOHUB</Link><h1>One-time admin setup</h1><p className="muted">Set a private ADMIN_SETUP_TOKEN of at least 32 characters in your deployment environment, redeploy, then enter it here. This route closes after the first administrator is created. Remove the token from the environment after setup.</p>{setupConfigured ? <AdminSetupForm /> : <p className="error">Administrator setup is not enabled. Add ADMIN_SETUP_TOKEN in the private Vercel project environment variables, then redeploy.</p>}</main>;
}
