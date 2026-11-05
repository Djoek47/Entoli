import { hasAnthropicKey } from '@entoli/analyzer';
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
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Analyze {app.repo ?? 'the repository'}</h2>
        <p className="muted" style={{ margin: 0 }}>
          Entoli downloads the default branch read-only, reads routes, buttons, forms and settings (React, Next.js, Vue), and drafts the map, the acts with a guessed contract, and what the app can and can't do.
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
      {runs.length === 0 ? <div className="empty">No analysis yet.</div> : runs.map((r) => (
        <section key={r.id} className="card stack">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'warn' : ''}`}>{r.status}</span>
            <span className="muted mono">{r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
            {r.status === 'done' ? <span className="muted mono">{r.filesScanned} files · {r.usedModel ? `model ${r.tokensIn.toLocaleString()} in / ${r.tokensOut.toLocaleString()} out · $${(r.costMicros / 1e6).toFixed(4)}` : 'static only'}</span> : null}
          </div>
          <pre className="block" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.log.map((l) => `› ${l}`).join('\n') || '…'}</pre>
          {r.status === 'done' ? <div><a className="btn" href={`/dashboard/apps/${app.id}/map`}>Review the map</a> <a className="btn ghost" href={`/dashboard/apps/${app.id}/skill`}>Edit the skill</a></div> : null}
        </section>
      ))}
    </div>
  );
}
