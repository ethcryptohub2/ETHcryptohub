import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { NotificationsSettings } from '../settings/notifications-settings';
import { NotificationsCenter } from '../dashboard/notifications-center';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <main className="shell"><section className="hero"><p className="mono">CUSTOMER ALERTS</p><h1>Notifications</h1><p className="muted">Your signal, execution, target, stop, and closure alerts.</p></section><div className="stack"><NotificationsCenter /><NotificationsSettings /></div></main>;
}
