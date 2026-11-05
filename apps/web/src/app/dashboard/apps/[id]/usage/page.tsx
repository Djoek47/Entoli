import { loadApp } from '@/lib/app-page';
import { getUsage } from '@/lib/apps';
import { estimate, PLANS, SOFT_LIMIT_SHARE } from '@/lib/plans';

export const metadata = { title: 'Usage' };

export default async function UsagePage({ params }: { params: Promise<{ id: string }> }) {
  const { app, db } = await loadApp(params);
  const u = await getUsage(db, app.id);
  const plan = PLANS[app.plan];
  const pct = Math.min(100, Math.round((u.textIntents / plan.includedText) * 100));
  return (
    <div className="stack">
      <div className="grid">
        <div className="card"><div className="kicker">Text intents · {u.period}</div><h2 style={{ margin: '6px 0' }}>{u.textIntents.toLocaleString()} <span className="muted" style={{ fontSize: 14 }}>/ {plan.includedText.toLocaleString()}</span></h2>
          <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          {pct >= SOFT_LIMIT_SHARE * 100 ? <p className="notice err" style={{ marginBottom: 0 }}>{plan.hardLimit ? 'Close to the free limit. At 100% the model fallback stops (on-device matching keeps working).' : 'Past 80%. Extra intents are billed at $2 per 1,000.'}</p> : null}
        </div>
        <div className="card"><div className="kicker">Voice turns</div><h2 style={{ margin: '6px 0' }}>{u.voiceTurns.toLocaleString()}</h2><div className="muted">{plan.voicePerTurn ? `$${plan.voicePerTurn} per turn` : 'Not on the Developer plan'}</div></div>
        <div className="card"><div className="kicker">Estimated this month</div><h2 style={{ margin: '6px 0' }}>${estimate(plan, u.textIntents, u.voiceTurns).toFixed(2)}</h2><div className="muted">{plan.name}</div></div>
        <div className="card"><div className="kicker">Model calls</div><h2 style={{ margin: '6px 0' }}>{u.modelCalls.toLocaleString()}</h2><div className="muted mono">{(u.tokensIn + u.tokensOut).toLocaleString()} tokens · ${(u.costMicros / 1e6).toFixed(4)} cost</div></div>
      </div>
      <p className="muted">Text intents count every phrase the SDK sends to Entoli. Phrases resolved on the device cost nothing and are not counted.</p>
    </div>
  );
}
