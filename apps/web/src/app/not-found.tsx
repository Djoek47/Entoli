import { Page } from '@/components/Page';

export default function NotFound() {
  return (
    <Page>
      <div className="center" style={{ minHeight: '50vh' }}>
        <div className="stack">
          <div className="kicker">404</div>
          <h1>Nothing here</h1>
          <p className="muted">This page doesn't exist, or it belongs to someone else.</p>
          <p><a className="btn" href="/dashboard">Back to your apps</a></p>
        </div>
      </div>
    </Page>
  );
}
