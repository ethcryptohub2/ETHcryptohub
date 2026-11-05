import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { Scanner } from './scanner';

export const dynamic = 'force-dynamic';
export default async function ScannerPage() {
  if (!(await currentUser())) redirect('/login');
  return <Scanner />;
}
