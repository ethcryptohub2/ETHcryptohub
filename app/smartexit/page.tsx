import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import SmartExitApp from '../../smartexit/apps/web/src/App';

export const dynamic = 'force-dynamic';
export default async function SmartExitPage() {
  if (!(await currentUser())) redirect('/login');
  return <SmartExitApp />;
}
