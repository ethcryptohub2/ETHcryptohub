'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

async function csrf() {
  const response = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json() as { data?: { csrfToken?: string }; error?: string };
  if (!response.ok || !result.data?.csrfToken) throw new Error(result.error ?? 'Security token unavailable.');
  return result.data.csrfToken;
}

export function AuthForm({
  mode,
  initialEmail = '',
  emailVerified = false,
}: {
  mode: 'signup' | 'login' | 'verify' | 'resend';
  initialEmail?: string;
  emailVerified?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [signupComplete, setSignupComplete] = useState(false);
  const [canResend, setCanResend] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setCanResend(false);
    const values = new FormData(event.currentTarget);
    const action = mode === 'verify' ? 'verify' : mode;
    const payload: Record<string, string> = {};
    for (const [key, value] of values.entries()) if (typeof value === 'string') payload[key] = value;
    try {
      const token = await csrf();
      const response = await fetch(`/api/auth/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as {
        data?: { verificationRequired?: boolean; signedIn?: boolean; verified?: boolean; notice?: string };
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        if (result.code === 'EMAIL_DELIVERY_FAILED') setCanResend(true);
        throw new Error(result.error ?? 'Request could not be completed.');
      }
      if (mode === 'signup') {
        setSignupComplete(true);
      } else if (mode === 'login') {
        router.push('/dashboard');
        router.refresh();
      } else if (mode === 'verify') {
        setNotice('Email verified. You can now sign in.');
        router.push(`/login?verified=1&email=${encodeURIComponent(email)}`);
      } else {
        setNotice(result.data?.notice ?? 'If this address needs verification, a code will be sent.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signup' ? 'Create your account' : mode === 'login' ? 'Welcome back' : mode === 'verify' ? 'Verify your email' : 'Resend verification';
  return (
    <main className="card auth">
      <Link className="brand" href="/">ETHCRYPTOHUB</Link>
      <h1>{title}</h1>
      <p className="muted">{mode === 'verify' ? 'Enter the six-digit code sent to your email.' : 'Secure access to your trading intelligence terminal.'}</p>
      {emailVerified && <p className="success">Email verified. Sign in to continue.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {canResend && <p><Link href={`/resend-verification?email=${encodeURIComponent(email)}`}>Request another verification email</Link></p>}
      {notice && <p role="status" className="success">{notice}</p>}
      <form className="stack" onSubmit={submit}>
        <label>Email<input name="email" type="email" required maxLength={255} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        {mode === 'signup' && <>
          <label>Password<input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
          <label>Full name (optional)<input name="fullName" maxLength={150} autoComplete="name" /></label>
          <div className="grid">
            <label>Country code<select name="countryCode" defaultValue="+91"><option>+91</option><option>+1</option><option>+44</option><option>+971</option></select></label>
            <label>10-digit phone (optional)<input name="phoneNumber" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} /></label>
          </div>
        </>}
        {mode === 'login' && <label>Password<input name="password" type="password" required maxLength={72} autoComplete="current-password" /></label>}
        {mode === 'verify' && <label>Six-digit code<input name="code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="one-time-code" /></label>}
        <button disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'login' ? 'Sign in' : mode === 'verify' ? 'Verify email' : 'Send new code'}</button>
      </form>
      <p className="form-footer">{mode === 'signup' ? <>Already registered? <a href="/login">Sign in</a></> : mode === 'login' ? <>New to ETHcryptohub? <a href="/signup">Create an account</a><br /><a href="/resend-verification">Resend verification code</a></> : <> <a href="/login">Back to sign in</a></>}</p>
      {signupComplete && (
        <div className="auth-dialog-backdrop">
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="signup-success-title">
            <h2 id="signup-success-title">Congratulations!</h2>
            <p>Your account has been created, and an activation code was sent to <strong>{email}</strong>.</p>
            <p>Enter the six-digit code to activate your account, then sign in.</p>
            <button
              autoFocus
              onClick={() => router.push(`/verify-email?email=${encodeURIComponent(email)}`)}
            >
              Enter activation code
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
