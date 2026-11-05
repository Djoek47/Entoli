import { loadApp } from '@/lib/app-page';
import { getUsage } from '@/lib/apps';
import { estimate, PLANS, SOFT_LIMIT_SHARE } from '@/lib/plans';

export const metadata = { title: 'Usage' };

export default async function UsagePage({ params }: { params: Promise<{ id: string }> }) {
  const { app, db } = await loadApp(params);
  const u = await getUsage(db, app.id);
  const plan = PLANS[app.plan];
  const pct = plan.includedText ? Math.min(100, Math.round((u.textIntents / plan.includedText) * 100)) : 0;
  if (!plan.ai) {
    return (
      <div className="stack">
        <p className="notice">{plan.name}: your app answers on the device (Layer 1), so there is nothing to meter. Entoli AI (Layer 2) and the voice tool are part of the <a href={`/dashboard/apps/${app.id}/billing`}>L2 plan</a>.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="grid">
        <div className="card"><div className="kicker">AI intents · {u.period}</div><h2 style={{ margin: '6px 0' }}>{u.textIntents.toLocaleString()} <span className="muted" style={{ fontSize: 14 }}>/ {plan.includedText.toLocaleString()}</span></h2>
          <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          {pct >= SOFT_LIMIT_SHARE * 100 ? <p className="notice err" style={{ marginBottom: 0 }}>{plan.hardLimit ? 'Close to the free limit. At 100% the model fallback stops (on-device matching keeps working).' : 'Past 80%. Extra intents are billed at $2 per 1,000.'}</p> : null}
        </div>
        <div className="card"><div className="kicker">Voice turns</div><h2 style={{ margin: '6px 0' }}>{u.voiceTurns.toLocaleString()}</h2><div className="muted">{plan.voicePerTurn ? `$${plan.voicePerTurn} per turn` : 'Not on the Developer plan'}</div></div>
        <div className="card"><div className="kicker">Estimated this month</div><h2 style={{ margin: '6px 0' }}>${estimate(plan, u.textIntents, u.voiceTurns).toFixed(2)}</h2><div className="muted">{plan.name}</div></div>
        <div className="card"><div className="kicker">Voice tool (dashboard)</div><h2 style={{ margin: '6px 0' }}>{u.toolTurns} <span className="muted" style={{ fontSize: 14 }}>/ {plan.voiceToolTurns}</span></h2><div className="muted">Turns used to integrate by speaking</div></div>
        <div className="card"><div className="kicker">Model calls</div><h2 style={{ margin: '6px 0' }}>{u.modelCalls.toLocaleString()}</h2><div className="muted mono">{(u.tokensIn + u.tokensOut).toLocaleString()} tokens · ${(u.costMicros / 1e6).toFixed(4)} cost</div></div>
      </div>
      <p className="muted">AI intents count the requests Entoli's AI answers (Layer 2 acts). Requests your app understands on the device, and every Layer 1 act, cost nothing and are not counted.</p>
    </div>
  );
}
