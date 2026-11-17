import { checkOriginalAction, runChecksAction, startOriginalSandboxAction, startSandboxAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { PLANS } from '@/lib/plans';
import { compare, isProject, projectFilesOf, type Side } from '@/lib/project';
import { Refresh } from '../analyze/Refresh';

export const metadata = { title: 'Project' };
export const maxDuration = 300;

const pct = (n: number | null) => (n === null ? 'not checked' : `${Math.round(n)}%`);

function SideCard({ title, side, appId, original }: { title: string; side: Side; appId: string; original: boolean }) {
  const ready = side.status === 'ready' && side.sandboxId;
  return (
    <div className="card stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong>{title}</strong>
        <span className={`pill ${ready ? 'ok' : side.status === 'failed' ? 'warn' : ''}`}>{side.status === 'none' ? 'not started' : side.status}</span>
      </div>
      <div className="muted">Screens reached: <strong>{pct(side.walkCoverage)}</strong> · phrases understood: <strong>{pct(side.phrasePercent)}</strong>{side.broken ? ` · ${side.broken} broken` : ''}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ready ? <a className="btn small" href={side.url!} target="_blank" rel="noreferrer">Open</a> : null}
        {ready ? <form action={(original ? checkOriginalAction : runChecksAction).bind(null, appId, side.sandboxId!)}><button className="btn small">Run the checks</button></form> : null}
      </div>
    </div>
  );
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db } = await loadApp(params);
  const sp = await searchParams;
  if (!isProject(app)) {
    return <div className="empty">This app is connected to a repository. A project built on Entoli starts from <a href="/dashboard">the dashboard</a>: from empty, or by copying an app and rebuilding it.</div>;
  }
  const files = await projectFilesOf(db, app.id);
  const rebuild = app.origin?.kind === 'rebuild';
  const c = await compare(db, app);
  const allowed = PLANS[app.plan].integration;
  const booting = c.rebuilt.status === 'booting' || c.original.status === 'booting';
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <p className="muted" style={{ margin: 0 }}>
        {rebuild
          ? <>A copy of <code>{app.repo}</code> becomes a new project that your coding agent rebuilds around Entoli. The original is never touched: it keeps running beside the new one and is judged by the same map and the same phrases.</>
          : <>You described: “{app.origin?.description}”. Entoli wrote the skill first (Map tab), then a small starter that already runs. Connect your coding agent (Keys tab) and tell it to build the rest; every change waits for your approval.</>}
      </p>
      {!allowed ? <p className="notice err">Running a project in the sandbox and connecting your agent are part of the L2 plan. <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a></p> : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <form action={startSandboxAction.bind(null, app.id)}><button className="btn primary" disabled={!allowed || booting}>Run the new app</button></form>
        {rebuild ? <form action={startOriginalSandboxAction.bind(null, app.id)}><button className="btn" disabled={!allowed || booting}>Run the original</button></form> : null}
        <a className="btn" href={`/api/apps/${app.id}/project`}>Download as zip</a>
      </div>
      {booting ? <Refresh everyMs={2500} /> : null}

      <section className="stack">
        <h2 style={{ margin: 0 }}>{rebuild ? 'Original and new, side by side' : 'The new app'}</h2>
        <div className="grid" style={{ gridTemplateColumns: rebuild ? 'repeat(auto-fit,minmax(280px,1fr))' : '1fr' }}>
          {rebuild ? <SideCard title="Original (kept as it is)" side={c.original} appId={app.id} original /> : null}
          <SideCard title="New (on Entoli)" side={c.rebuilt} appId={app.id} original={false} />
        </div>
        <p style={{ margin: 0 }}><strong>{c.verdict}</strong></p>
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Files ({files.length})</h2>
        <p className="muted" style={{ margin: 0 }}>Held here, not in any repository. Download the zip when you are happy with it and put it wherever you like; or ask your agent to continue.</p>
        <ul style={{ margin: 0, paddingLeft: 18, columns: 2 }}>{files.map((f) => <li key={f.path}><code>{f.path}</code> <span className="muted">{f.content.length.toLocaleString()} B</span></li>)}</ul>
      </section>
    </div>
  );
}
