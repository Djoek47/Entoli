import { saveSkillAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';

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
