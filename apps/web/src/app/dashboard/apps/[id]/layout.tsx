import { loadApp } from '@/lib/app-page';
import { PLANS } from '@/lib/plans';
import { Tabs } from './Tabs';

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { app } = await loadApp(params);
  return (
    <div>
      <div className="kicker"><a href="/dashboard">Apps</a> / {PLANS[app.plan].name}</div>
      <h1>{app.name}</h1>
      <div className="muted mono">{app.repo ?? 'no repository'} {app.installationId ? '· connected (read-only)' : ''}</div>
      <Tabs id={app.id} />
      {children}
    </div>
  );
}
