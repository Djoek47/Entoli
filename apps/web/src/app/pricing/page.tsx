import { DocsNav, Page } from '@/components/Page';
import { MANAGED_SETUP_FROM_USD, OVERAGE_PER_1000, PLANS } from '@/lib/plans';

export const metadata = { title: 'Pricing' };

export default function Pricing() {
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Pricing</div>
      <h1>Pay for the depth and the voice</h1>
      <DocsNav at="/pricing" />
      <p>Per app, per month. Text intents are cheap because most resolve on the device and never reach us; only the phrases sent to Entoli count. Voice is metered per spoken turn.</p>
      <div className="grid">
        {Object.values(PLANS).map((p) => (
          <div key={p.id} className="card stack">
            <h3 style={{ margin: 0 }}>{p.name}</h3>
            <div className="mono">{p.priceUsd ? `$${p.priceUsd} / app / month` : '$0'}</div>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>{p.includedText.toLocaleString()} text intents a month{p.hardLimit ? '' : `, then $${OVERAGE_PER_1000} per 1,000`}</li>
              <li>{p.voicePerTurn ? `Voice $${p.voicePerTurn} per turn` : 'Text only'}</li>
              <li>{p.layers.join(' + ')}{p.id === 'developer' ? ', 1 app' : ''}</li>
              {p.id !== 'developer' ? <li>Guided integration (pull request)</li> : null}
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
