'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

type AuthMode = 'signup' | 'login' | 'verify' | 'resend' | 'forgot-password' | 'reset-password';

async function csrf() {
  const response = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json() as { data?: { csrfToken?: string }; error?: string };
  if (!response.ok || !result.data?.csrfToken) throw new Error(result.error ?? 'Security token unavailable.');
  return result.data.csrfToken;
}

export function AuthForm({
  mode,
  initialEmail = '',
  initialError = '',
  emailVerified = false,
}: {
  mode: AuthMode;
  initialEmail?: string;
  initialError?: string;
  emailVerified?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [signupComplete, setSignupComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const values = new FormData(event.currentTarget);
    const payload: Record<string, string> = {};
    for (const [key, value] of values.entries()) {
      if (typeof value === 'string') payload[key] = value;
    }

    const action = mode === 'forgot-password' ? 'recovery'
      : mode === 'reset-password' ? 'update-password'
        : mode;
    try {
      const token = await csrf();
      const response = await fetch(`/api/auth/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as {
        data?: {
          verificationRequired?: boolean;
          signedIn?: boolean;
          notice?: string;
          passwordUpdated?: boolean;
        };
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        if (mode === 'login' && result.code === 'EMAIL_NOT_VERIFIED') {
          router.push(`/verify-email?email=${encodeURIComponent(email)}`);
          return;
        }
        throw new Error(result.error ?? 'Request could not be completed.');
      }

      if (mode === 'signup') {
        if (result.data?.signedIn) {
          router.push('/dashboard');
          router.refresh();
        } else {
          setSignupComplete(true);
        }
      } else if (mode === 'login') {
        router.push('/dashboard');
        router.refresh();
      } else if (mode === 'reset-password') {
        setNotice('Password updated. You can continue to your dashboard.');
        router.push('/dashboard');
        router.refresh();
      } else {
        setNotice(result.data?.notice ?? 'If this address needs attention, instructions will be sent.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signup' ? 'Create your account'
    : mode === 'login' ? 'Welcome back'
      : mode === 'verify' ? 'Confirm your email'
        : mode === 'resend' ? 'Resend confirmation'
          : mode === 'forgot-password' ? 'Recover your password'
            : 'Set a new password';
  const description = mode === 'verify'
    ? 'Email confirmation now uses a secure Supabase link. Legacy verification codes are no longer accepted.'
    : 'Secure access to your trading intelligence terminal.';
  const emailRequired = mode !== 'reset-password' && mode !== 'verify';

  return (
    <main className="card auth">
      <div className="auth-topline"><Link className="brand" href="/">ETHCRYPTOHUB</Link><ThemeToggle /></div>
      <h1>{title}</h1>
      <p className="muted">{description}</p>
      {emailVerified && <p className="success">Email confirmed. Sign in to continue.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status" className="success">{notice}</p>}
      {mode === 'verify' ? (
        <div className="stack">
          <p>Use the confirmation link sent by Supabase. If it expired, request a new link.</p>
          <Link href={`/resend-verification?email=${encodeURIComponent(email)}`}>Resend confirmation email</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={(event) => void submit(event)}>
          {emailRequired && (
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                maxLength={255}
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          )}
          {mode === 'signup' && <>
            <label>Password<input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
            <label>Full name (optional)<input name="fullName" maxLength={150} autoComplete="name" /></label>
            <div className="grid">
              <label>Country code<select name="countryCode" defaultValue="+91"><option>+91</option><option>+1</option><option>+44</option><option>+971</option></select></label>
              <label>10-digit phone (optional)<input name="phoneNumber" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} /></label>
            </div>
          </>}
          {mode === 'login' && <label>Password<input name="password" type="password" required maxLength={72} autoComplete="current-password" /></label>}
          {mode === 'reset-password' && <>
            <label>New password<input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
            <label>Confirm new password<input name="confirmation" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
          </>}
          <button disabled={busy}>{busy ? 'Please wait…'
            : mode === 'signup' ? 'Create account'
              : mode === 'login' ? 'Sign in'
                : mode === 'resend' ? 'Send confirmation link'
                  : mode === 'forgot-password' ? 'Send recovery link'
                    : 'Update password'}</button>
        </form>
      )}
      <p className="form-footer">
        {mode === 'signup' ? <>Already registered? <Link href="/login">Sign in</Link></>
          : mode === 'login' ? <>New to ETHcryptohub? <Link href="/signup">Create an account</Link><br /><Link href="/forgot-password">Forgot password?</Link><br /><Link href="/resend-verification">Resend confirmation</Link></>
            : mode === 'reset-password' ? <Link href="/login">Back to sign in</Link>
              : <Link href="/login">Back to sign in</Link>}
      </p>
      {signupComplete && (
        <div className="auth-dialog-backdrop">
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="signup-success-title">
            <h2 id="signup-success-title">Confirm your email</h2>
            <p>If this address can be registered, Supabase will send a confirmation link to <strong>{email}</strong>.</p>
            <p>Open the link to finish creating your account, then sign in.</p>
            <button autoFocus onClick={() => router.push(`/login?email=${encodeURIComponent(email)}`)}>
              Continue to sign in
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
