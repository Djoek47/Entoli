import { actLayer } from '@entoli/sdk/skill';
import { desc, eq } from 'drizzle-orm';
import { integrations } from '@/db/schema';
import { loadApp } from '@/lib/app-page';
import { getUsage } from '@/lib/apps';
import { PLANS } from '@/lib/plans';
import { StudioBar } from './StudioBar';
import { Tabs } from './Tabs';

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { app, db, skill } = await loadApp(params);
  const plan = PLANS[app.plan];
  const [latest] = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(1);
  const usage = await getUsage(db, app.id);
  const voiceTool = plan.voiceToolTurns > 0 && (process.env.NODE_ENV !== 'production' || app.subscriptionStatus === 'active' || app.subscriptionStatus === 'trialing' || app.subscriptionStatus === 'past_due');
  return (
    <div>
      <div className="kicker"><a href="/dashboard">Apps</a> / {plan.name}</div>
      <h1>{app.name}</h1>
      <div className="muted mono">{app.repo ?? 'no repository'} {app.installationId ? '· connected (read-only)' : ''}</div>
      <Tabs id={app.id} />
      {children}
      <StudioBar
        appId={app.id}
        appName={app.name}
        repo={app.repo}
        voiceTool={voiceTool}
        voiceInput={plan.voiceInput}
        quota={plan.voiceToolTurns}
        used={usage.toolTurns}
        acts={(skill?.acts ?? []).map((a) => ({ name: a.name, title: a.title ?? a.name, layer: actLayer(skill!, a) }))}
        integration={latest && latest.status !== 'pr_opened' ? { id: latest.id, changes: latest.changes.map((c) => ({ id: c.id, title: c.title, file: c.file, status: c.status })) } : null}
      />
    </div>
  );
}
