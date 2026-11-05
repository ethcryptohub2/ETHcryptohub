'use client';

import { useEffect, useState } from 'react';

type UserRow = { id: number; email: string; full_name: string | null; country_code: string; phone_number: string | null; x_handle: string | null; is_x_verified: number; is_email_verified: number; is_active: number; role: string; created_at: string };
type Result = { metrics: { total: string; verified: string; x_verified: string; inactive: string }; users: UserRow[] };

export function AdminUsers() {
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const body = await response.json() as { data?: Result; error?: string };
    if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load user database.');
    setData(body.data);
  };
  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Admin load failed.')); }, []);
  async function action(userId: number, action: string) {
    if (action === 'delete_user' && !window.confirm('Delete this user permanently?')) return;
    setBusy(true); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const token = (await csrfResponse.json() as { data?: { csrfToken: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('Secure session unavailable.');
      const response = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ userId, action }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'User action failed.');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'User action failed.'); }
    finally { setBusy(false); }
  }
  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading user records…</p>;
  return <section className="stack">{error && <p className="error">{error}</p>}<div className="grid">{Object.entries({ 'Total users': data.metrics.total, 'Verified email': data.metrics.verified, 'X verified': data.metrics.x_verified, 'Inactive': data.metrics.inactive }).map(([label, value]) => <article className="card" key={label}><p className="mono">{label.toUpperCase()}</p><h2>{value}</h2></article>)}</div><div className="card" style={{ overflowX: 'auto' }}><table className="scan-table"><thead><tr><th>User</th><th>Contact</th><th>X</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.users.map((user) => <tr key={user.id}><td>{user.email}<br /><span className="muted">{user.full_name ?? '—'}</span></td><td>{user.country_code} {user.phone_number ?? '—'}</td><td>{user.x_handle ? `@${user.x_handle}` : '—'} · {user.is_x_verified ? 'Verified' : 'Pending'}</td><td>{user.is_email_verified ? 'Verified' : 'Pending'}</td><td>{user.role}</td><td>{user.is_active ? 'Active' : 'Suspended'}</td><td><div className="links"><button disabled={busy} onClick={() => void action(user.id, 'toggle_x_verification')}>X status</button><button disabled={busy || user.role === 'admin'} onClick={() => void action(user.id, 'toggle_active')}>Suspend/restore</button><button disabled={busy || user.role === 'admin'} onClick={() => void action(user.id, 'delete_user')}>Delete</button></div></td></tr>)}</tbody></table></div></section>;
}
