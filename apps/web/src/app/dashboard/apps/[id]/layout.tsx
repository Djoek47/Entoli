import { actLayer } from '@entoli/sdk/skill';
import { desc, eq } from 'drizzle-orm';
import { integrations } from '@/db/schema';
import { loadApp } from '@/lib/app-page';
import { getUsage } from '@/lib/apps';
import { checklist } from '@/lib/checklist';
import { PLANS } from '@/lib/plans';
import { latestSandbox } from '@/lib/sandbox-boot';
import { StudioBar } from './StudioBar';
import { Tabs } from './Tabs';

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { app, db, skill } = await loadApp(params);
  const plan = PLANS[app.plan];
  const [latest] = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(1);
  const usage = await getUsage(db, app.id);
  const [sbx] = await latestSandbox(db, app.id);
  const progress = await checklist(db, app);
  const voiceTool = plan.voiceToolTurns > 0 && (process.env.NODE_ENV !== 'production' || app.subscriptionStatus === 'active' || app.subscriptionStatus === 'trialing' || app.subscriptionStatus === 'past_due');
  return (
    <div>
      <div className="kicker"><a href="/dashboard">Apps</a> / {plan.name}</div>
      <h1>{app.name}</h1>
      <div className="muted mono">{app.repo ?? 'no repository'} {app.installationId ? '· connected (read-only)' : ''}</div>
      {progress.next ? (
        <section className="card" aria-label="Getting started" style={{ margin: '12px 0' }}>
          <div><strong>Getting started</strong> <span className="muted">· {progress.doneCount} of {progress.steps.length} · next: <a href={progress.next.href}>{progress.next.title}</a></span></div>
          <ol style={{ margin: '10px 0 0', paddingLeft: 20 }}>
            {progress.steps.map((st) => (
              <li key={st.id} style={{ margin: '4px 0' }}>
                <span aria-label={st.done ? 'done' : 'to do'}>{st.done ? '✓' : '○'}</span>{' '}
                {st.done ? <span className="muted">{st.title}</span> : <a href={st.href}><strong>{st.title}</strong></a>}
                {!st.done && st.id === progress.next?.id ? <div className="muted">{st.hint}</div> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <Tabs id={app.id} />
      {children}
      <StudioBar
        appId={app.id}
        appName={app.name}
        repo={app.repo}
        voiceTool={voiceTool}
        voiceInput={plan.voiceInput}
        liveMinutes={plan.liveMinutes}
        liveUsedSeconds={usage.liveSeconds}
        quota={plan.voiceToolTurns}
        used={usage.toolTurns}
        acts={(skill?.acts ?? []).map((a) => ({ name: a.name, title: a.title ?? a.name, layer: actLayer(skill!, a) }))}
        sandboxId={sbx?.status === 'ready' ? sbx.id : null}
        integration={latest && latest.status !== 'pr_opened' ? { id: latest.id, changes: latest.changes.map((c) => ({ id: c.id, title: c.title, file: c.file, status: c.status })) } : null}
      />
    </div>
  );
}
