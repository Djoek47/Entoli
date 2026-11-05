import { Footer, Logo } from './Logo';

/** Public pages (docs, pricing, legal): header, a readable column, footer. */
export function Page({ children, nav = true }: { children: React.ReactNode; nav?: boolean }) {
  return (
    <>
      <header className="top"><div className="wrap">
        <Logo />
        {nav ? <>
          <a href="/docs" className="muted" style={{ textDecoration: 'none', fontWeight: 600 }}>Docs</a>
          <a href="/pricing" className="muted" style={{ textDecoration: 'none', fontWeight: 600 }}>Pricing</a>
        </> : null}
        <span className="spacer" />
        <a className="btn small primary" href="/dashboard">Dashboard</a>
      </div></header>
      <main className="wrap prose">{children}</main>
      <Footer />
    </>
  );
}

export function DocsNav({ at }: { at: string }) {
  const items = [['/docs', 'Quickstart'], ['/docs/skill', 'Skill format'], ['/docs/safety', 'Safety model'], ['/pricing', 'Pricing']] as const;
  return <nav className="tabs" aria-label="Docs">{items.map(([href, label]) => <a key={href} href={href} aria-current={href === at ? 'page' : undefined}>{label}</a>)}</nav>;
}
