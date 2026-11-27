import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { SubscriptionPanel } from '../subscription-panel';
import { SettingsForm } from '../settings/settings-form';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <main className="shell"><section className="hero"><p className="mono">MEMBER PROFILE</p><h1>Profile</h1><p className="muted">{user.email}</p></section><div className="stack"><SubscriptionPanel /><SettingsForm initialHandle={user.x_handle ?? ''} /></div></main>;
}
