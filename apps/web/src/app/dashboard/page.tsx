import { getDb } from '@/db';
import { listApps } from '@/lib/apps';
import { PLANS } from '@/lib/plans';
import { requireUser } from '@/lib/session';
import { createAppAction, startProjectAction } from './actions';

export const metadata = { title: 'Apps' };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const apps = await listApps(await getDb(), user.id);
  return (
    <div className="stack">
      <div><span className="kicker">Dashboard</span><h1>Your apps</h1></div>
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      {apps.length === 0 ? (
        <div className="empty">No apps yet. Bring one: give it a name and its GitHub repository.</div>
      ) : (
        <div className="grid apps">
          {apps.map((a) => (
            <a key={a.id} className="card" href={`/dashboard/apps/${a.id}/map`}>
              <div className="kicker">{PLANS[a.plan].name}</div>
              <h3 style={{ margin: '6px 0' }}>{a.name}</h3>
              <div className="muted mono">{a.repo ?? 'no repository yet'}</div>
              <div style={{ marginTop: 10 }}>
                <span className={`pill ${a.skillStatus === 'published' ? 'ok' : ''}`}>skill: {a.skillStatus}</span>{' '}
                {a.installationId ? <span className="pill ok">repo connected</span> : null}
              </div>
            </a>
          ))}
        </div>
      )}
      <form action={createAppAction} className="card stack" aria-label="New app">
        <h2 style={{ margin: 0 }}>New app</h2>
        <div className="row">
          <label>Name<input name="name" required maxLength={80} placeholder="Fieldnotes" /></label>
          <label>GitHub repository<input name="repo" placeholder="owner/name or https://github.com/owner/name" /></label>
          <button className="btn primary">Create</button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Public repositories can be analyzed right away. Private ones need the Entoli GitHub App (read-only), which you can install from the app page.</p>
      </form>
      <form action={startProjectAction} className="card stack" aria-label="Start a new project on Entoli">
        <h2 style={{ margin: 0 }}>Build a new app on Entoli</h2>
        <p className="muted" style={{ margin: 0 }}>Nothing to connect yet. Entoli writes the skill first, starts a small runnable app around it, and your own coding agent builds the rest, through guardrails.</p>
        <div className="row">
          <label>Name<input name="name" required maxLength={80} placeholder="Todos" /></label>
          <label>Start<select name="how" defaultValue="blank"><option value="blank">From empty: I will describe it</option><option value="rebuild">Copy an existing app and rebuild it</option></select></label>
        </div>
        <label>Describe the app <span className="muted">(from empty)</span><textarea name="description" rows={3} maxLength={2000} placeholder="A todo list with a done screen. I can add, complete and clear todos." /></label>
        <label>Original repository <span className="muted">(rebuild: the original is kept and runs beside the new one)</span><input name="repo" placeholder="owner/name" /></label>
        <div><button className="btn primary">Start the project</button></div>
      </form>
    </div>
  );
}
