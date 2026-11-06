import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../lib/auth';
import { SettingsForm } from './settings-form';
import { NotificationsSettings } from './notifications-settings';
import { SubscriptionPanel } from '../subscription-panel';

export const dynamic = 'force-dynamic';
export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">ETHCRYPTOHUB</Link><nav className="links"><Link href="/dashboard">Dashboard</Link><Link href="/scanner">Scanner</Link><Link href="/binance">Binance API</Link></nav></header><section className="hero"><p className="mono">ACCOUNT · SETTINGS</p><h1>Identity & access.</h1><p className="muted">{user.email} · {user.is_x_verified ? 'X verified' : 'X verification pending'}</p></section><div className="stack"><SubscriptionPanel /><NotificationsSettings /><SettingsForm initialHandle={user.x_handle ?? ''} /></div></main>;
}
