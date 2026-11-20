import { hasAnthropicKey, type Plan } from '@entoli/analyzer';
import { startAnalysisAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { ANALYSIS_LIMITS, listAnalyses } from '@/lib/analysis';
import { Refresh } from './Refresh';

export const metadata = { title: 'Analyze' };
export const maxDuration = 300;

export default async function AnalyzePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db } = await loadApp(params);
  const sp = await searchParams;
  const runs = await listAnalyses(db, app.id);
  const live = runs.some((r) => r.status === 'queued' || r.status === 'running');
  const model = hasAnthropicKey();
  const plan = (runs.find((r) => r.status === 'done' && r.plan)?.plan ?? null) as Plan | null;
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Analyze {app.repo ?? 'the repository'}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Entoli downloads the default branch read-only, works out what kind of app it is, reads routes, buttons, forms and settings (React, Next.js, Vue, Svelte, plain HTML, jQuery, AngularJS and more), and drafts the map, the acts with a guessed contract, and what the app can and can't do.
          {model
            ? ` Claude then reviews the draft (capped at ${ANALYSIS_LIMITS.maxInputTokens.toLocaleString()} input tokens); it can only refine acts the scan found.`
            : ' No model is configured on this deployment, so the draft is static heuristics only.'}
          {' '}The result is saved as a draft: nothing is published until you do it in the Skill tab.
        </p>
        <form action={startAnalysisAction.bind(null, app.id)}>
          <button className="btn primary" disabled={!app.repo || live}>{live ? 'Analyzing…' : runs.length ? 'Analyze again' : 'Analyze'}</button>
          {!app.repo ? <span className="muted"> Add the repository in the <a href={`/dashboard/apps/${app.id}/map`}>Map</a> tab first.</span> : null}
        </form>
      </section>
      {live ? <Refresh everyMs={2000} /> : null}
      {plan ? (
        <section className="card stack" aria-label="What this app is">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 className="sub" style={{ margin: 0 }}>{plan.profile.label}</h2>
            <span className={`pill ${plan.profile.support === 'full' ? 'ok' : plan.profile.support === 'none' ? 'warn' : ''}`}>{{ full: 'fully supported', partial: 'supported, read from markup', manual: 'host only: name features by hand', none: 'not a web UI' }[plan.profile.support]}</span>
          </div>
          <p className="muted" style={{ margin: 0 }}>{plan.profile.language} · {plan.profile.bundler} · {plan.profile.packageManager}{plan.profile.dev ? ` · start: ${plan.profile.dev}` : ''}{plan.profile.entry ? ` · mount in ${plan.profile.entry}` : plan.profile.page ? ` · page ${plan.profile.page}` : ''}. Evidence: {plan.profile.evidence.join('; ')}.</p>
          <p style={{ margin: 0 }}>Found {plan.found.screens} screen{plan.found.screens === 1 ? '' : 's'}, {plan.found.controls} control{plan.found.controls === 1 ? '' : 's'}, {plan.found.acts.length} feature{plan.found.acts.length === 1 ? '' : 's'}.</p>
          {plan.steps.length ? (
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {plan.steps.map((st) => (
                <li key={st.title} style={{ margin: '6px 0' }}>
                  <strong>{st.title}</strong>
                  <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{st.detail}</div>
                  {st.code ? <pre tabIndex={0} className="block" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{st.code}</pre> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {plan.caveats.length ? <ul className="notice" style={{ margin: 0, paddingLeft: 20 }}>{plan.caveats.map((c) => <li key={c}>{c}</li>)}</ul> : null}
        </section>
      ) : null}
      {runs.length === 0 ? <div className="empty">No analysis yet.</div> : runs.map((r) => (
        <section key={r.id} className="card stack">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'warn' : ''}`}>{r.status}</span>
            <span className="muted mono">{r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
            {r.status === 'done' ? <span className="muted mono">{r.filesScanned} files · {r.usedModel ? `model ${r.tokensIn.toLocaleString()} in / ${r.tokensOut.toLocaleString()} out · $${(r.costMicros / 1e6).toFixed(4)}` : 'static only'}</span> : null}
          </div>
          <pre tabIndex={0} className="block" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.log.map((l) => `› ${l}`).join('\n') || '…'}</pre>
          {r.status === 'done' ? <div><a className="btn" href={`/dashboard/apps/${app.id}/map`}>Review the map</a> <a className="btn ghost" href={`/dashboard/apps/${app.id}/skill`}>Edit the skill</a></div> : null}
        </section>
      ))}
    </div>
  );
}
