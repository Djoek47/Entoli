import { runTestAction, setPreviewAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { listRuns, type StoredReport } from '@/lib/test-runs';

export const metadata = { title: 'Test' };
export const maxDuration = 300;

export default async function TestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db, skill } = await loadApp(params);
  const sp = await searchParams;
  const runs = await listRuns(db, app.id);
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <p className="muted" style={{ margin: 0 }}>A real browser walks the map on your running app: every screen must load without errors, and every mapped control must be found where the skill says it is. Coverage is verified ÷ checkable; screens with route parameters and nodes without a selector are listed, not counted.</p>
      <form action={setPreviewAction.bind(null, app.id)} className="row card">
        <label>Preview URL<input name="url" type="url" defaultValue={app.previewUrl ?? ''} placeholder="https://my-app-git-main.vercel.app" /></label>
        <button className="btn">Save</button>
      </form>
      <form action={runTestAction.bind(null, app.id)}>
        <button className="btn primary" disabled={!app.previewUrl || !skill}>Run the walk now</button>
      </form>
      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Run it in CI instead</summary>
        <pre className="block" style={{ marginTop: 10 }}>{`npx entoli-test entoli.skill.json $PREVIEW_URL --min 90 \\
  --upload https://entoli.dev --key $ENTOLI_KEY`}</pre>
        <p className="muted" style={{ margin: 0 }}>Exits 2 when something is broken or coverage is under <code>--min</code>, so it can gate a deploy.</p>
      </details>
      {runs.length === 0 ? <div className="empty">No runs yet.</div> : runs.map((run) => {
        const r = run.report as StoredReport;
        return (
          <section key={run.id} className="card stack">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontFamily: 'var(--display)', fontSize: 28 }}>{run.coverage}%</strong>
              <span className={`pill ${r.broken.length ? 'warn' : 'ok'}`}>{r.broken.length ? `${r.broken.length} broken` : 'nothing broken'}</span>
              <span className="muted mono">{r.verified}/{r.checked} verified · {r.unchecked.length} not checkable · {r.source} · {run.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
            </div>
            <div className="meter"><i style={{ width: `${run.coverage}%` }} /></div>
            <div className="muted mono">{run.url}</div>
            {r.broken.length ? (
              <table><thead><tr><th>Broken</th><th>Kind</th><th>Why</th></tr></thead>
                <tbody>{r.broken.map((b) => <tr key={b.id}><td>{b.title}</td><td><span className="pill">{b.kind}</span></td><td className="mono">{b.reason}</td></tr>)}</tbody></table>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
