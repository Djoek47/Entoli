import { desc, eq } from 'drizzle-orm';
import { checkoutAction, devPlanAction, managedAction, portalAction } from '../../../actions';
import { managedRequests } from '@/db/schema';
import { loadApp } from '@/lib/app-page';
import { getUsage } from '@/lib/apps';
import { billingConfigured } from '@/lib/billing';
import { estimate, MANAGED_SETUP_FROM_USD, OVERAGE_PER_1000, PLANS } from '@/lib/plans';

export const metadata = { title: 'Billing' };

export default async function BillingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db, user } = await loadApp(params);
  const sp = await searchParams;
  const current = PLANS[app.plan];
  const u = await getUsage(db, app.id);
  const stripeOn = billingConfigured();
  const devSwitch = !stripeOn && process.env.NODE_ENV !== 'production';
  const managed = await db.select().from(managedRequests).where(eq(managedRequests.userId, user.id)).orderBy(desc(managedRequests.createdAt)).limit(5);
  return (
    <div className="stack">
      {sp.checkout === 'success' ? <p className="notice">Payment received. The plan switches as soon as Stripe confirms it (usually a few seconds).</p> : null}
      {sp.managed === 'success' ? <p className="notice">Thank you. Your managed setup request is paid; we will contact you within one business day.</p> : null}
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      {!stripeOn ? <p className="notice err">Billing is not configured on this deployment (STRIPE_SECRET_KEY).{devSwitch ? ' Development mode: switch plans below to try the limits.' : ''}</p> : null}

      <section>
        <div className="kicker">Current plan</div>
        <h2 style={{ margin: '4px 0' }}>{current.name} {app.subscriptionStatus && app.plan !== 'developer' ? <span className="pill">{app.subscriptionStatus}</span> : null}</h2>
        <p className="muted" style={{ margin: 0 }}>This month: {u.textIntents.toLocaleString()} text intents, {u.voiceTurns.toLocaleString()} voice turns · estimated ${estimate(current, u.textIntents, u.voiceTurns).toFixed(2)}</p>
        {app.stripeCustomerId && stripeOn ? <form action={portalAction.bind(null, app.id)} style={{ marginTop: 10 }}><button className="btn">Invoices, card and cancellation</button></form> : null}
      </section>

      <div className="grid">
        {(['developer', 'l1', 'l2'] as const).map((id) => {
          const p = PLANS[id];
          const isCurrent = app.plan === id;
          return (
            <div key={id} className="card stack" style={isCurrent ? { borderColor: 'var(--lime)' } : undefined}>
              <div className="kicker">{p.layers.join(' + ')}</div>
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              <div className="mono">{p.priceUsd === 0 ? '$0' : `$${p.priceUsd} / app / month`}</div>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>{p.includedText.toLocaleString()} text intents a month{p.hardLimit ? ' (hard limit)' : `, then $${OVERAGE_PER_1000} per 1,000`}</li>
                <li>{p.voicePerTurn ? `Voice: $${p.voicePerTurn} per turn` : 'Text only'}</li>
                {id === 'developer' ? <li>1 app</li> : null}
                {id === 'l2' ? <li>Settings and access by voice, with a yes</li> : null}
              </ul>
              {isCurrent ? <span className="pill ok">current</span>
                : devSwitch ? <form action={devPlanAction.bind(null, app.id, id)}><button className="btn small">Switch (dev)</button></form>
                : id !== 'developer' && stripeOn ? <form action={checkoutAction.bind(null, app.id, id)}><button className="btn primary">{app.plan === 'developer' ? 'Upgrade' : 'Switch'}</button></form>
                : id === 'developer' && app.stripeCustomerId && stripeOn ? <form action={portalAction.bind(null, app.id)}><button className="btn small ghost">Cancel in portal</button></form>
                : null}
            </div>
          );
        })}
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Managed setup</h2>
        <p className="muted" style={{ margin: 0 }}>From ${MANAGED_SETUP_FROM_USD.toLocaleString()}, one time. We scan your app, build and test the first skill with you, and integrate it (including over MCP). Then any monthly plan.</p>
        <form action={managedAction.bind(null, app.id)} className="stack">
          <label>What should we know?<textarea name="notes" style={{ minHeight: 90, fontFamily: 'var(--sans)' }} placeholder="Stack, deadline, which features matter most…" maxLength={2000} /></label>
          <div><button className="btn lime" disabled={!stripeOn}>Request managed setup</button></div>
        </form>
        {managed.length ? (
          <table><thead><tr><th>Requested</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>{managed.map((m) => <tr key={m.id}><td>{m.createdAt.toISOString().slice(0, 10)}</td><td><span className={`pill ${m.status === 'paid' || m.status === 'done' ? 'ok' : ''}`}>{m.status.replace('_', ' ')}</span></td><td className="muted">{m.notes?.slice(0, 80)}</td></tr>)}</tbody></table>
        ) : null}
      </section>
    </div>
  );
}
