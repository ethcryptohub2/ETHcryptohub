'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    setBusy(true); setError('');
    try {
      const csrfResponse = await fetch('/api/csrf', { cache: 'no-store' });
      const token = (await csrfResponse.json() as { data?: { csrfToken: string } }).data?.csrfToken;
      if (!csrfResponse.ok || !token) throw new Error('Secure sign-out could not start.');
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      if (!response.ok) throw new Error('Sign-out failed.');
      router.push('/login');
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-out failed.'); }
    finally { setBusy(false); }
  }
  return <span><button onClick={() => void logout()} disabled={busy}>{busy ? 'Signing out…' : 'Log out'}</button>{error && <span role="alert" className="error">{error}</span>}</span>;
}
