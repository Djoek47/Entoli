import { saveSkillAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { AGENT_FILES } from '@/lib/agent-skill';
import { PLANS } from '@/lib/plans';

export const metadata = { title: 'Skill' };

const STARTER = (name: string) => ({ entoli: '0.1', app: { name }, layer: 'L1', mode: 'text', map: [], knowledge: [], acts: [] });

export default async function SkillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app } = await loadApp(params);
  const sp = await searchParams;
  const json = JSON.stringify(app.skill ?? STARTER(app.name), null, 2);
  return (
    <div className="stack">
      {sp.saved ? <p className="notice">Saved as {sp.saved}.</p> : null}
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <p className="muted" style={{ margin: 0 }}>This is <code>entoli.skill.json</code>. Commit it next to your app and pass it to <code>mount()</code>. Only valid skills are saved; slot types are a closed set: choice, quantity, when, person, freeText.</p>
      <section className="card stack">
        <h3 style={{ margin: 0 }}>Hand it to your coding agent</h3>
        <p className="muted" style={{ margin: 0 }}>Already working with Claude Code, Cursor or another agent? Download the skill as a file it understands, put it in your repository, and ask it to integrate Entoli. It carries the skill, where each act lives in your code, and how to wire it.</p>
        {PLANS[app.plan].priceUsd > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(Object.keys(AGENT_FILES) as (keyof typeof AGENT_FILES)[]).map((f) => (
              <a key={f} className="btn small" href={`/api/apps/${app.id}/agent-skill?format=${f}`}>{AGENT_FILES[f].label} <code className="muted">{AGENT_FILES[f].path}</code></a>
            ))}
          </div>
        ) : <p className="muted" style={{ margin: 0 }}>Part of the L1 and L2 plans. <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a></p>}
      </section>
      <form action={saveSkillAction.bind(null, app.id)} className="stack">
        <textarea name="skill" defaultValue={json} spellCheck={false} aria-label="entoli.skill.json" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn">Save draft</button>
          <button className="btn primary" name="publish" value="1">Save and publish</button>
          <a className="btn ghost" href={`data:application/json;charset=utf-8,${encodeURIComponent(json)}`} download="entoli.skill.json">Download</a>
        </div>
      </form>
    </div>
  );
}
