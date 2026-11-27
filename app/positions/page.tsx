import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { PositionsPanel } from './positions-panel';

export const dynamic = 'force-dynamic';

export default async function PositionsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <PositionsPanel />;
}
