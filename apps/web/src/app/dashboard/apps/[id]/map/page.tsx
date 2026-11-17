import type { MapNode } from '@entoli/sdk/skill';
import { acceptProposalFormAction, proposeFormAction, setActLayerAction, setRepoAction, undoProposalFormAction } from '../../../actions';
import { proposalOf } from '@/lib/proposal';
import { actLayer } from '@entoli/sdk/skill';
import { PLANS } from '@/lib/plans';
import { loadApp } from '@/lib/app-page';
import { githubAppConfigured, installUrl } from '@/lib/github';

export const metadata = { title: 'Map' };

function Tree({ nodes, parent, acts }: { nodes: MapNode[]; parent: string | undefined; acts: Set<string> }) {
  const kids = nodes.filter((n) => n.parent === parent);
  if (!kids.length) return null;
  return (
    <ul className="tree">
      {kids.map((n) => (
        <li key={n.id}>
          <span className="node"><span className="pill">{n.kind}</span> <strong>{n.title}</strong>
            {n.path ? <code className="muted">{n.path}</code> : null}
            {n.act ? <code className={acts.has(n.act) ? '' : 'muted'}>→ {n.act}</code> : null}
          </span>
          <Tree nodes={nodes} parent={n.id} acts={acts} />
        </li>
      ))}
    </ul>
  );
}

export default async function MapPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, skill } = await loadApp(params);
  const sp = await searchParams;
  const install = installUrl(app.id);
  return (
    <div className="stack">
      {sp.connected ? <p className="notice">Repository connected, read-only.</p> : null}
      {sp.error ? <p className="notice err">{sp.error === 'install-repo' ? 'The GitHub App installation cannot see this repository. Add it to the installation and try again.' : sp.error}</p> : null}
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Repository</h2>
        <form action={setRepoAction.bind(null, app.id)} className="row">
          <label>owner/name<input name="repo" defaultValue={app.repo ?? ''} required /></label>
          <button className="btn">Save</button>
        </form>
        {githubAppConfigured() && install ? (
          <p style={{ margin: 0 }}><a className="btn lime" href={install}>{app.installationId ? 'Change GitHub access' : 'Connect with GitHub (read-only)'}</a> <span className="muted">Needed for private repositories.</span></p>
        ) : <p className="muted" style={{ margin: 0 }}>GitHub App not configured on this deployment: public repositories only.</p>}
      </section>
      <section>
        <h2>Map</h2>
        {skill?.map.length ? <Tree nodes={skill.map} parent={undefined} acts={new Set(skill.acts.map((a) => a.name))} /> : (
          <div className="empty">No map yet. <a href={`/dashboard/apps/${app.id}/analyze`}>Analyze the repository</a> or paste a skill in the <a href={`/dashboard/apps/${app.id}/skill`}>Skill</a> tab.</div>
        )}
      </section>
      {skill?.acts.length ? (() => {
        const prop = proposalOf(app);
        const groups: [string, string, 'L2' | 'L1' | 'off'][] = [['The AI answers (Layer 2)', 'One sentence replaces several clicks.', 'L2'], ['On the device (Layer 1)', 'Short and predictable: no AI, no cost.', 'L1'], ['Keep manual', 'Reaches outside the app, or cannot be undone.', 'off']];
        return (
          <section className="card stack">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>What should Entoli take over?</h2>
              <form action={proposeFormAction.bind(null, app.id)}><button className="btn small" disabled={!PLANS[app.plan].integration}>{prop ? 'Propose again' : 'Propose'}</button></form>
            </div>
            {!PLANS[app.plan].integration ? <p className="notice err" style={{ margin: 0 }}>The proposal conversation is part of the L2 plan. <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a></p> : null}
            {prop ? (
              <>
                <p style={{ margin: 0 }}>{prop.spoken}</p>
                {groups.map(([title, hint, layer]) => {
                  const items = (prop.items as { act: string; title: string; recommend: string; reason: string; change: boolean; current: string }[]).filter((i) => i.recommend === layer);
                  return items.length ? (
                    <div key={layer}>
                      <strong>{title}</strong> <span className="muted">{hint}</span>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{items.map((i) => <li key={i.act}><strong>{i.title}</strong> {i.change ? <span className="pill">now {i.current}</span> : null}<div className="muted">{i.reason}</div></li>)}</ul>
                    </div>
                  ) : null;
                })}
                <div style={{ display: 'flex', gap: 8 }}>
                  {prop.applied
                    ? <><span className="pill ok">applied</span><form action={undoProposalFormAction.bind(null, app.id)}><button className="btn small ghost">Undo</button></form></>
                    : <form action={acceptProposalFormAction.bind(null, app.id)}><button className="btn primary" disabled={!(prop.items as { change: boolean }[]).some((i) => i.change)}>Accept the proposal</button></form>}
                </div>
                <p className="muted" style={{ margin: 0 }}>You can still set any feature yourself in the table below, or by voice: “why is delete manual?”, “move search to layer one”.</p>
              </>
            ) : <p className="muted" style={{ margin: 0 }}>Entoli looks at every feature and tells you what it would hand to the AI, keep on the device, or leave manual, and why. Say “what should I expose?” or press Propose.</p>}
          </section>
        );
      })() : null}
      {skill?.acts.length ? (
        <section>
          <h2>Acts</h2>
          <p className="muted">Choose a layer for each act: <strong>L2</strong>, Entoli AI answers and makes the change on the card; <strong>L1</strong>, only the device can trigger it, the AI never sees it; <strong>off</strong>, not connected at all (keep sensitive things manual).</p>
          <table><thead><tr><th>Act</th><th>Phrases</th><th>Slots</th><th>Radius</th><th>Contract</th><th>Layer</th></tr></thead>
            <tbody>{skill.acts.map((a) => (
              <tr key={a.name}><td><code>{a.name}</code><div className="muted">{a.title}</div></td>
                <td>{a.phrases.slice(0, 3).join(', ')}</td>
                <td className="mono">{Object.entries(a.slots ?? {}).map(([k, s]) => `${k}:${s.type}`).join(' ')}</td>
                <td><span className={`pill ${a.radius === 'external' ? 'warn' : ''}`}>{a.radius}</span></td>
                <td className="muted">{[a.undo ? 'undo' : 'no undo', a.kind === 'setting' ? 'setting' : '', a.exact ? 'exact' : '', a.voiceOnly ? 'voice only' : ''].filter(Boolean).join(' · ')}</td>
                <td>
                  <form key={`${a.name}-${actLayer(skill, a)}`} action={setActLayerAction.bind(null, app.id, a.name)} style={{ display: 'flex', gap: 6 }}>
                    <select name="layer" defaultValue={actLayer(skill, a)} aria-label={`Layer for ${a.name}`} style={{ minHeight: 32, padding: '4px 8px', width: 'auto' }}>
                      <option value="L2" disabled={!PLANS[app.plan].ai}>L2 · AI answers</option>
                      <option value="L1">L1 · device only</option>
                      <option value="off">off · not connected</option>
                    </select>
                    <button className="btn small">Set</button>
                  </form>
                </td></tr>
            ))}</tbody></table>
        </section>
      ) : null}
    </div>
  );
}
