import { desc, eq } from 'drizzle-orm';
import { changeStatusAction, openPrAction, startIntegrationAction } from '../../../actions';
import { integrations } from '@/db/schema';
import { loadApp } from '@/lib/app-page';
import { integrationAllowed, QUESTIONS, type Answers } from '@/lib/integration';
import { Refresh } from '../analyze/Refresh';

export const metadata = { title: 'Guided integration' };
export const maxDuration = 300;

function Diff({ text }: { text: string }) {
  const lines = text.split('\n').slice(2); // drop the ===/--- header noise jsdiff adds first
  return (
    <pre className="block" style={{ margin: 0, fontSize: 12, lineHeight: 1.45 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ background: l.startsWith('+') && !l.startsWith('+++') ? 'color-mix(in srgb, var(--lime) 18%, transparent)' : l.startsWith('-') && !l.startsWith('---') ? 'color-mix(in srgb, var(--warn) 12%, transparent)' : undefined, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export default async function IntegratePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db, skill } = await loadApp(params);
  const sp = await searchParams;
  const blocked = integrationAllowed(app);
  const [latest] = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(1);
  const busy = latest?.status === 'generating' || latest?.status === 'interview';
  const approved = latest?.changes.filter((c) => c.status === 'approved').length ?? 0;
  const showInterview = !latest || latest.status === 'failed' || sp.new === '1' || latest.status === 'pr_opened';

  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      {sp.pr ? <p className="notice">Pull request opened: <a href={sp.pr}>{sp.pr}</a></p> : null}
      <p className="muted" style={{ margin: 0 }}>Answer a few questions. Entoli prepares the integration feature by feature; you review every change as a diff and approve it on its own. Approved changes open as one pull request on {app.repo ?? 'your repository'}. Write access to GitHub is requested only for that pull request.</p>
      {blocked ? <p className="notice err">{blocked} {app.plan === 'developer' ? <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a> : null}</p> : null}
      {!skill ? <div className="empty">No skill yet. <a href={`/dashboard/apps/${app.id}/analyze`}>Analyze the repository</a> first.</div> : null}

      {busy ? <><Refresh everyMs={2500} /><p className="notice">Preparing the changes… this can take a minute.</p></> : null}

      {latest && !busy && latest.status !== 'failed' ? (
        <section className="stack">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>Changes</h2>
            <span className="pill">{latest.changes.length} prepared · {approved} approved</span>
            {latest.status === 'pr_opened' && latest.prUrl ? <a className="btn small lime" href={latest.prUrl}>Open the pull request</a> : null}
          </div>
          {latest.error ? <div className="notice"><strong>Notes</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{latest.error.split('\n').map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
          {latest.changes.map((c) => (
            <div key={c.id} className="card stack">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div><strong>{c.title}</strong> <code className="muted">{c.file}</code>{c.baseSha === null ? <span className="pill" style={{ marginLeft: 6 }}>new file</span> : null}</div>
                <span className={`pill ${c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'warn' : ''}`}>{c.status}</span>
              </div>
              {c.summary ? <p className="muted" style={{ margin: 0 }}>{c.summary}</p> : null}
              <Diff text={c.diff} />
              {latest.status !== 'pr_opened' ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  {c.status !== 'approved' ? <form action={changeStatusAction.bind(null, app.id, latest.id, c.id, 'approved')}><button className="btn primary small">Approve this change</button></form> : null}
                  {c.status !== 'rejected' ? <form action={changeStatusAction.bind(null, app.id, latest.id, c.id, 'rejected')}><button className="btn small">Reject</button></form> : null}
                  {c.status !== 'pending' ? <form action={changeStatusAction.bind(null, app.id, latest.id, c.id, 'pending')}><button className="btn ghost small">Undo</button></form> : null}
                </div>
              ) : null}
            </div>
          ))}
          {latest.status !== 'pr_opened' ? (
            <form action={openPrAction.bind(null, app.id, latest.id)} className="row card">
              <p className="muted" style={{ margin: 0 }}>{approved ? `${approved} approved change${approved > 1 ? 's' : ''} will go into one pull request.` : 'Approve at least one change.'} Nothing else is written.</p>
              <button className="btn lime" disabled={!approved}>Open pull request</button>
            </form>
          ) : <p className="muted"><a href={`/dashboard/apps/${app.id}/integrate?new=1`}>Start a new integration</a></p>}
        </section>
      ) : null}
      {latest?.status === 'failed' ? <p className="notice err">The last attempt failed: {latest.error}</p> : null}

      {showInterview && skill && !blocked && !busy ? (
        <form action={startIntegrationAction.bind(null, app.id)} className="card stack">
          <h2 style={{ margin: 0 }}>Interview</h2>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 6 }}>Which features should Entoli be able to run?</legend>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 6 }}>
              {skill.acts.map((a) => (
                <label key={a.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
                  <input type="checkbox" name="features" value={a.name} defaultChecked style={{ width: 'auto', minHeight: 0 }} />
                  <span>{a.title ?? a.name} {a.kind === 'setting' ? <span className="pill">setting</span> : null}{a.radius !== 'self' ? <span className="pill warn">{a.radius}</span> : null}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {(Object.keys(QUESTIONS) as (keyof typeof QUESTIONS)[]).map((k) => (
            <fieldset key={k} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontWeight: 600, marginBottom: 6 }}>{QUESTIONS[k].q}</legend>
              {QUESTIONS[k].options.map(([value, label], i) => (
                <label key={value} style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name={k} value={value} defaultChecked={(latest?.answers as Answers | undefined)?.[k as keyof Answers] === value || (!latest && i === (k === 'settingsBy' ? 1 : 0))} style={{ width: 'auto', minHeight: 0 }} /> {label}
                </label>
              ))}
            </fieldset>
          ))}
          <div><button className="btn primary">Prepare the changes</button></div>
        </form>
      ) : null}
    </div>
  );
}
