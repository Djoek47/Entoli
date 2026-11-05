import { addKnowledgeAction, removeKnowledgeAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';

export const metadata = { title: 'Knowledge' };

export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, skill } = await loadApp(params);
  const sp = await searchParams;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>Questions like “can it export to PDF?” are answered only from this list. Anything not here gets “I don't know”.</p>
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      {!skill ? <div className="empty">No skill yet. <a href={`/dashboard/apps/${app.id}/analyze`}>Analyze</a> first.</div> : (
        <>
          <table><thead><tr><th>Topic</th><th>Can?</th><th>Answer</th><th /></tr></thead>
            <tbody>{skill.knowledge.map((k, i) => (
              <tr key={i}><td>{k.topic}</td><td><span className={`pill ${k.can ? 'ok' : 'warn'}`}>{k.can ? 'can' : "can't"}</span></td><td>{k.answer}</td>
                <td><form action={removeKnowledgeAction.bind(null, app.id, i)}><button className="btn small ghost" aria-label={`Remove ${k.topic}`}>Remove</button></form></td></tr>
            ))}</tbody></table>
          <form action={addKnowledgeAction.bind(null, app.id)} className="card stack">
            <h3 style={{ margin: 0 }}>Teach it something</h3>
            <div className="row">
              <label>Topic<input name="topic" required placeholder="export to PDF" /></label>
              <label style={{ maxWidth: 140 }}>Can it?<select name="can"><option value="yes">Yes</option><option value="no">No</option></select></label>
            </div>
            <label>Answer (optional)<input name="answer" placeholder="No. Notes can't be exported to PDF yet." /></label>
            <div><button className="btn primary">Add</button></div>
          </form>
        </>
      )}
    </div>
  );
}
