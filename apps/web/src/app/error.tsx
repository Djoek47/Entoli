'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="center">
      <div className="stack" style={{ maxWidth: 420 }}>
        <div className="kicker">Something went wrong</div>
        <h1>That didn't work</h1>
        <p className="muted">Nothing was changed. Try again; if it keeps happening, send us this reference: <code>{error.digest ?? 'no reference'}</code>.</p>
        <div><button className="btn primary" onClick={reset}>Try again</button> <a className="btn ghost" href="/dashboard">Back to your apps</a></div>
      </div>
    </main>
  );
}
