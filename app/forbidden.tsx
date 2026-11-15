import Link from 'next/link';

export default function ForbiddenPage() {
  return <main className="shell">
    <section className="hero">
      <p className="mono">403 · FORBIDDEN</p>
      <h1>Administrator access required.</h1>
      <p className="muted">Your account is not authorized to access this resource.</p>
      <Link href="/dashboard">Return to dashboard</Link>
    </section>
  </main>;
}
