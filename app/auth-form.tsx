'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

async function csrf() {
  const response = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json() as { data?: { csrfToken?: string }; error?: string };
  if (!response.ok || !result.data?.csrfToken) throw new Error(result.error ?? 'Security token unavailable.');
  return result.data.csrfToken;
}

export function AuthForm({
  mode,
  initialEmail = '',
  initialCode = '',
  emailVerified = false,
}: {
  mode: 'signup' | 'login' | 'verify' | 'resend' | 'forgot' | 'reset';
  initialEmail?: string;
  initialCode?: string;
  emailVerified?: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const autoSubmittedCode = useRef('');
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [signupComplete, setSignupComplete] = useState(false);
  const [canResend, setCanResend] = useState(false);
  const [verificationRequired, setVerificationRequired] = useState(false);

  function openVerificationPage() {
    router.push(`/verify-email?email=${encodeURIComponent(email)}`);
  }

  useEffect(() => {
    if (mode !== 'verify' || !initialEmail || !/^[0-9]{6}$/.test(initialCode) || autoSubmittedCode.current === initialCode) return;
    autoSubmittedCode.current = initialCode;
    formRef.current?.requestSubmit();
  }, [initialCode, initialEmail, mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    setCanResend(false);
    const values = new FormData(event.currentTarget);
    const action = mode === 'verify' ? 'verify' : mode === 'forgot' ? 'password-reset-request' : mode === 'reset' ? 'password-reset' : mode;
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
        const needsVerification = mode === 'login'
          && response.status === 403
          && (result.code === 'EMAIL_NOT_VERIFIED' || result.error?.toLowerCase().includes('verify your email'));
        if (needsVerification) {
          setVerificationRequired(true);
          openVerificationPage();
          return;
        }
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
      } else if (mode === 'reset') {
        setNotice('Password reset. You can now sign in with your new password.');
      } else {
        setNotice(result.data?.notice ?? 'If an account exists for this address, a reset code will be sent.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signup' ? 'Create your account'
    : mode === 'login' ? 'Welcome back'
      : mode === 'verify' ? 'Verify your email'
        : mode === 'resend' ? 'Resend verification'
          : mode === 'forgot' ? 'Reset your password'
            : 'Choose a new password';
  return (
    <main className="card auth">
      <div className="auth-topline"><Link className="brand" href="/">ETHCRYPTOHUB</Link><ThemeToggle /></div>
      <h1>{title}</h1>
      <p className="muted">{mode === 'verify' || mode === 'reset'
        ? 'Enter the six-digit code sent to your email.'
        : mode === 'forgot' ? 'We will send a reset code if an active verified account exists.'
          : 'Secure access to your trading intelligence terminal.'}</p>
      {emailVerified && <p className="success">Email verified. Sign in to continue.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {verificationRequired && (
        <p role="status" className="success">
          Your email needs verification. <button type="button" onClick={openVerificationPage}>Enter verification code</button>
        </p>
      )}
      {canResend && <p><Link href={`/resend-verification?email=${encodeURIComponent(email)}`}>Request another verification email</Link></p>}
      {notice && <p role="status" className="success">{notice}</p>}
      <form ref={formRef} className="stack" onSubmit={submit}>
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
        {(mode === 'verify' || mode === 'reset') && <label>Six-digit code<input name="code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="one-time-code" defaultValue={initialCode} /></label>}
        {mode === 'reset' && <>
          <label>New password<input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
          <label>Confirm new password<input name="confirmation" type="password" required minLength={8} maxLength={72} autoComplete="new-password" /></label>
        </>}
        <button disabled={busy}>{busy ? 'Please wait…'
          : mode === 'signup' ? 'Create account'
            : mode === 'login' ? 'Sign in'
              : mode === 'verify' ? 'Verify email'
                : mode === 'resend' ? 'Send new code'
                  : mode === 'forgot' ? 'Send reset code'
                    : 'Reset password'}</button>
      </form>
      {mode === 'forgot' && notice && <p><Link href={`/reset-password?email=${encodeURIComponent(email)}`}>Enter your reset code</Link></p>}
      <p className="form-footer">{mode === 'signup'
        ? <>Already registered? <a href="/login">Sign in</a></>
        : mode === 'login'
          ? <>New to ETHcryptohub? <a href="/signup">Create an account</a><br /><a href="/resend-verification">Resend verification code</a><br /><a href="/forgot-password">Forgot password?</a></>
          : mode === 'forgot' ? <a href="/login">Back to sign in</a>
            : mode === 'reset' ? <a href={`/forgot-password?email=${encodeURIComponent(email)}`}>Request another reset code</a>
              : <> <a href="/login">Back to sign in</a></>}</p>
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
