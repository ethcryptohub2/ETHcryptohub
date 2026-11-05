import Link from 'next/link';
import { AdminSetupForm } from './setup-form';

export const dynamic = 'force-dynamic';
export default function AdminSetupPage() {
  return <main className="card auth"><Link className="brand" href="/">ETHCRYPTOHUB</Link><h1>One-time admin setup</h1><p className="muted">Use your private ADMIN_SETUP_TOKEN. This route closes after the first administrator is created.</p><AdminSetupForm /></main>;
}
