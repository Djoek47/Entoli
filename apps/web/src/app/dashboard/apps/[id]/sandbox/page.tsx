import { runChecksAction, startSandboxAction, stopSandboxAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { PLANS } from '@/lib/plans';
import { latestSandbox, type Checks } from '@/lib/sandbox-boot';
import { isProject } from '@/lib/project';
import { explainFailure } from '@/lib/sandbox-hints';
import { Refresh } from '../analyze/Refresh';

export const metadata = { title: 'Test sandbox' };
export const maxDuration = 300;

const ICON: Record<string, string> = { ok: '✓', ran: '✓', 'not-understood': '✗', 'wrong-act': '✗', failed: '✗', skipped: '·' };
const WORDS: Record<string, string> = { ok: 'understood', ran: 'ran, then undone', 'not-understood': 'not understood', 'wrong-act': 'wrong act', failed: 'failed', skipped: 'not checked' };

export default async function SandboxPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db, skill } = await loadApp(params);
  const sp = await searchParams;
  const allowed = PLANS[app.plan].integration;
  const [sbx] = await latestSandbox(db, app.id);
  const booting = sbx?.status === 'booting';
  const ready = sbx?.status === 'ready' && sbx.url;
  const checks = (sbx?.results ?? null) as Checks | null;
  const screens = (skill?.map ?? []).filter((n) => n.kind === 'screen' && n.path && !n.path.includes(':') && !n.path.includes('*')).slice(0, 4);
  const pending = sbx?.applied?.filter((a) => a.status === 'pending').length ?? 0;
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <p className="muted" style={{ margin: 0 }}>Your app, running in an isolated sandbox with the Entoli layer applied, so you can try it before approving anything. Changes still waiting for your approval are included: the sandbox is where you judge them. Type or speak to the bar inside each window.</p>
      {!allowed ? <p className="notice err">The test sandbox is part of the L2 plan. <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a></p> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <form action={startSandboxAction.bind(null, app.id)}><button className="btn primary" disabled={!allowed || (!app.repo && !isProject(app)) || booting}>{booting ? 'Starting…' : ready ? 'Restart the sandbox' : 'Start the test sandbox'}</button></form>
        {ready ? <form action={runChecksAction.bind(null, app.id, sbx.id)}><button className="btn">Run the checks</button></form> : null}
        {ready ? <form action={stopSandboxAction.bind(null, app.id, sbx.id)}><button className="btn ghost">Stop it</button></form> : null}
      </div>
      {booting ? <Refresh everyMs={2500} /> : null}

      {sbx ? (
        <section className="card stack">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`pill ${sbx.status === 'ready' ? 'ok' : sbx.status === 'failed' ? 'warn' : ''}`}>{sbx.status}</span>
            <span className="muted mono">{sbx.provider} · {sbx.createdAt.toISOString().slice(11, 16)} UTC{sbx.expiresAt && ready ? ` · until ${sbx.expiresAt.toISOString().slice(11, 16)}` : ''}</span>
            {ready ? <a className="btn small" href={sbx.url!} target="_blank" rel="noreferrer">Open in a tab</a> : null}
          </div>
          <pre tabIndex={0} className="block" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{sbx.log.map((l) => `› ${l}`).join('\n')}</pre>
          {sbx.error ? (() => { const h = explainFailure(sbx.error); return (
            <div className="notice err" role="alert" style={{ margin: 0 }}>
              {h ? <p style={{ margin: 0 }}><strong>{h.what}</strong> {h.fix}</p> : null}
              <details><summary>Technical detail</summary><pre tabIndex={0} style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{sbx.error}</pre></details>
            </div>); })() : null}
          {sbx.applied?.length ? (
            <div>
              <strong>Applied in this sandbox</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{sbx.applied.map((a) => <li key={a.file}><code>{a.file}</code> <span className={`pill ${a.status === 'approved' ? 'ok' : ''}`}>{a.status === 'approved' ? 'approved' : 'waiting for you'}</span></li>)}</ul>
              {pending ? <p className="muted" style={{ margin: '6px 0 0' }}>Happy with it? Approve those in <a href={`/dashboard/apps/${app.id}/integrate`}>Guided integration</a>.</p> : null}
            </div>
          ) : null}
        </section>
      ) : <div className="empty">No sandbox yet.</div>}

      {ready ? (
        <section className="stack">
          <h2 style={{ margin: 0 }}>Windows</h2>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(420px,1fr))' }}>
            {(screens.length ? screens : [{ id: 'home', title: 'Your app', path: '/' }]).map((n) => (
              <div key={n.id} className="card stack" style={{ padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{n.title}</strong><a className="muted mono" href={`${sbx.url}${n.path}`} target="_blank" rel="noreferrer">{n.path}</a></div>
                <iframe title={`${n.title} in the sandbox`} src={`${sbx.url}${n.path}`} allow="microphone" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style={{ width: '100%', height: 420, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {checks ? (
        <section className="stack">
          <h2 style={{ margin: 0 }}>Checks</h2>
          {!checks.hasBar ? <p className="notice err">The app has no Entoli bar yet, so nothing could be tried. Wire it (your coding agent, or the integration) and restart the sandbox.</p> : (
            <p style={{ margin: 0 }}><strong>{checks.summary.percent}%</strong> of the acts did what they should ({checks.summary.good} of {checks.summary.checked}){checks.walk ? <> · map walk {checks.walk.coverage}% ({checks.walk.verified}/{checks.walk.checked})</> : null}</p>
          )}
          <table><thead><tr><th><span className="sr-only">Actions</span></th><th>Act</th><th>Said</th><th>Result</th></tr></thead>
            <tbody>{checks.phrases.map((p) => (
              <tr key={p.act}><td>{ICON[p.status]}</td><td>{p.title}<div className="muted mono">{p.act}</div></td><td>“{p.phrase}”</td><td><span className={`pill ${p.status === 'ok' || p.status === 'ran' ? 'ok' : p.status === 'skipped' ? '' : 'warn'}`}>{WORDS[p.status]}</span>{p.reason ? <div className="muted">{p.reason}</div> : null}</td></tr>
            ))}</tbody></table>
          {checks.walk?.broken.length ? <p className="muted">Broken on the map: {checks.walk.broken.map((b) => `${b.title}${b.reason ? ` (${b.reason})` : ''}`).join('; ')}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
