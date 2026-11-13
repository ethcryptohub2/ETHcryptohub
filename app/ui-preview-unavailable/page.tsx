import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUiPreviewRequested } from '../../lib/ui-preview-mode.mjs';

export const dynamic = 'force-dynamic';

export default function UiPreviewUnavailablePage() {
  if (!isUiPreviewRequested(process.env)) notFound();

  return (
    <main className="shell">
      <section className="card">
        <p className="mono">RESTRICTED UI PREVIEW</p>
        <h1>Unavailable in UI Preview</h1>
        <p className="muted">
          Database-backed, authenticated, and exchange-connected features are intentionally unavailable.
          No account data, signals, or trade results are simulated.
        </p>
        <Link className="button" href="/">Return to the public preview</Link>
      </section>
    </main>
  );
}
