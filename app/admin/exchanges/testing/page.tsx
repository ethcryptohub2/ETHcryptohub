import Link from 'next/link';
import { forbidden, redirect } from 'next/navigation';
import { currentUser } from '../../../../lib/auth';
import { isApprovedAdminDemoStagingTarget } from '../../../../lib/admin-demo-staging-policy';
import { ExchangeDemoReview } from './exchange-demo-review';

export const dynamic = 'force-dynamic';

export default async function ExchangeTestingPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') forbidden();

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">ETHCRYPTOHUB · CONTROL</Link>
        <nav className="links">
          <Link href="/admin/exchanges">Exchange Control</Link>
          <Link href="/admin">Admin</Link>
        </nav>
      </header>
      <section className="hero">
        <p className="mono">ADMIN ONLY · DEMO / TESTNET</p>
        <h1>Exchange Demo Lab</h1>
        <p className="muted">Review provider readiness and the approvals required for Staging demo testing.</p>
      </section>
      <ExchangeDemoReview auditMonitoring={(process.env.VERCEL_ENV === 'preview' || process.env.SMARTEXIT_DEPLOYMENT_ENV === 'staging') &&
        (process.env.VERCEL_GIT_COMMIT_REF === 'functional-staging' || process.env.RENDER_GIT_BRANCH === 'functional-staging' || process.env.SMARTEXIT_DEPLOYMENT_BRANCH === 'functional-staging') &&
        process.env.SMARTEXIT_STAGING_SUPABASE_PROJECT_REF === 'ghecpkpaxbrvehquhzkr' &&
        isApprovedAdminDemoStagingTarget(process.env)} />
      <p className="muted"><Link href="/admin/exchanges">Review provider readiness</Link></p>
    </main>
  );
}
