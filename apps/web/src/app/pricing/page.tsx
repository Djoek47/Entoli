import { DocsNav, Page } from '@/components/Page';
import { MANAGED_SETUP_FROM_USD, planFeatures, PLANS } from '@/lib/plans';

export const metadata = { title: 'Pricing' };

export default function Pricing() {
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Pricing</div>
      <h1>Buy the skill, or the skill and the integration</h1>
      <DocsNav at="/pricing" />
      <p>Per app, per month. <strong>L1</strong> is the skill: your app answers on the device (Layer 1), and if you already work with Claude Code, Cursor or another coding agent, you export the skill to it and it does the wiring. <strong>L2</strong> adds the integration: Entoli's AI answers your users (Layer 2), and you integrate your app by connecting GitHub and speaking to the dashboard. The product demonstrates itself.</p>
      <div className="grid">
        {Object.values(PLANS).map((p) => (
          <div key={p.id} className="card stack">
            <h3 style={{ margin: 0 }}>{p.name}</h3>
            <div className="mono">{p.priceUsd ? `$${p.priceUsd} / app / month` : '$0'}</div>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              {planFeatures(p).map((f) => <li key={f}>{f}</li>)}
            </ul>
          </div>
        ))}
        <div className="card stack">
          <h3 style={{ margin: 0 }}>Managed</h3>
          <div className="mono">From ${MANAGED_SETUP_FROM_USD.toLocaleString()}, once</div>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}><li>We scan and integrate (also over MCP)</li><li>First skill built and tested</li><li>Then any monthly plan</li></ul>
        </div>
      </div>
      <p className="muted">Layer 3 (the operating system) is coming. Prices in USD, excluding taxes.</p>
      <p><a className="btn primary" href="/dashboard">Start free</a></p>
    </Page>
  );
}
