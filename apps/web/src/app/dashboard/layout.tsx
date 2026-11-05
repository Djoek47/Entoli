import { Footer, Logo } from '@/components/Logo';
import { authConfigured } from '@/lib/auth';
import { requireUser } from '@/lib/session';
import { signOutAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <>
      <header className="top"><div className="wrap">
        <Logo href="/dashboard" />
        <a href="/dashboard" className="muted" style={{ textDecoration: 'none', fontWeight: 600 }}>Apps</a>
        <a href="/docs" className="muted" style={{ textDecoration: 'none', fontWeight: 600 }}>Docs</a>
        <span className="spacer" />
        <span className="who">
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : null}
          {user.login}
          {authConfigured ? <form action={signOutAction}><button className="btn ghost small">Sign out</button></form> : <span className="pill warn">dev mode</span>}
        </span>
      </div></header>
      <main className="wrap">{children}</main>
      <Footer />
    </>
  );
}
