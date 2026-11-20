import { CSS } from '@entoli/sdk';
import { describeTokens, themeCss, type DesignTokens } from '@entoli/design';
import { extractDesignAction, resetDesignTweaksAction, sampleDesignAction, tweakDesignAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { designAllowed, tokensOf, type Stored } from '@/lib/design';

export const metadata = { title: 'Design' };
export const maxDuration = 300;

/** The generated theme, minus the OS-dark media rule: each preview is forced light or dark by its own wrapper. */
function previewCss(t: DesignTokens): string {
  return themeCss(t).split('\n').filter((l) => !l.startsWith('@media')).join('\n').replace(':root[data-theme="dark"] .entoli,.dark .entoli', '.dark .entoli');
}

/** The real Entoli markup (bar, "Do exactly this" card), styled by the real stylesheet and the generated theme. */
function Preview({ tokens, dark }: { tokens: DesignTokens; dark?: boolean }) {
  const c = { ...tokens.colors, ...(dark ? tokens.dark : {}) };
  return (
    <div className={dark ? 'dark' : ''} style={{ background: c.background, color: c.foreground, fontFamily: tokens.fonts.body, padding: 16, borderRadius: 12, border: '1px solid var(--line)' }}>
      <div className="entoli">
        <div className="entoli-bar" role="search">
          <span className="entoli-mark" aria-hidden>{'>'}<span className="entoli-wave"><i /><i /><i /></span></span>
          <input className="entoli-input" placeholder="Ask this app" readOnly aria-label="Preview of the Entoli bar" />
          <button type="button" className="entoli-btn primary">Go</button>
        </div>
        <div className="entoli-stage">
          <p className="entoli-said">You: <q>change my email to ana@example.com</q></p>
          <div className="entoli-card exact" data-phase="exact">
            <div className="entoli-kicker">Exactly this</div>
            <div className="entoli-title">Change email</div>
            <ul className="entoli-args"><li><span>New email</span><code>ana@example.com</code></li></ul>
            <p className="entoli-why">It reaches outside the app, so it needs a yes to exactly this.</p>
            <div className="entoli-actions"><button type="button" className="entoli-btn go">Do exactly this</button><button type="button" className="entoli-btn">Not that</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}

const rows = (t: DesignTokens): [string, string, string, string?][] => [
  ...(Object.entries(t.colors).map(([k, v]) => [`colors.${k}`, k, v, v]) as [string, string, string, string][]),
  ['fonts.body', 'text font', t.fonts.body], ['fonts.display', 'heading font', t.fonts.display], ['fonts.mono', 'code font', t.fonts.mono],
  ['radius', 'corner radius', `${t.radius}px`], ['shadow', 'shadow', t.shadow],
  ...(Object.entries(t.dark ?? {}).map(([k, v]) => [`dark.${k}`, `dark ${k}`, v as string, v as string]) as [string, string, string, string][]),
];

export default async function DesignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app } = await loadApp(params);
  const sp = await searchParams;
  const allowed = designAllowed(app);
  const tokens = tokensOf(app.design as Stored | null);
  const stored = app.design as Stored | null;
  return (
    <div className="stack">
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <p className="muted" style={{ margin: 0 }}>So the Entoli bar and card look like they belong to your app. Entoli reads your code (CSS variables, Tailwind and theme files, font imports) and, when a sandbox is running, looks at what people actually see. Then tweak it in plain words.</p>
      {!allowed ? <p className="notice err">The design extractor is part of the L2 plan. <a href={`/dashboard/apps/${app.id}/billing`}>See plans</a></p> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <form action={extractDesignAction.bind(null, app.id)}><button className="btn primary" disabled={!allowed || !app.repo}>{tokens ? 'Extract again' : 'Extract my design'}</button></form>
        <form action={sampleDesignAction.bind(null, app.id)}><button className="btn" disabled={!allowed}>Look at the running app</button></form>
      </div>

      {tokens ? (
        <>
          <p style={{ margin: 0 }}>{describeTokens(tokens)}</p>
          <style dangerouslySetInnerHTML={{ __html: `${CSS}\n${previewCss(tokens)}` }} />
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))' }}>
            <div className="stack"><strong>Light</strong><Preview tokens={tokens} /></div>
            {tokens.dark ? <div className="stack"><strong>Dark</strong><Preview tokens={tokens} dark /></div> : null}
          </div>

          <form action={tweakDesignAction.bind(null, app.id)} className="row card">
            <label>Adjust in your own words<input name="instruction" placeholder="rounder · no shadow · make the accent blue · use #2563eb as the accent" maxLength={200} /></label>
            <button className="btn primary">Apply</button>
          </form>
          {stored?.tweaks.length ? (
            <p className="muted" style={{ margin: 0 }}>Applied: {stored.tweaks.map((t) => `“${t}”`).join(', ')}. <form action={resetDesignTweaksAction.bind(null, app.id)} style={{ display: 'inline' }}><button className="btn small ghost">Undo all</button></form></p>
          ) : null}

          <table><thead><tr><th>Token</th><th><span className="sr-only">Actions</span></th><th>Value</th><th>Where it came from</th></tr></thead>
            <tbody>{rows(tokens).map(([key, label, value, swatch]) => (
              <tr key={key}><td>{label}</td><td style={{ width: 28 }}>{swatch ? <span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: swatch, border: '1px solid var(--line)' }} /> : null}</td>
                <td className="mono">{value}</td><td className="muted">{tokens.sources[key] === 'default' ? <span className="pill">not found: Entoli's own</span> : tokens.sources[key] ?? ''}</td></tr>
            ))}</tbody></table>
          <p className="muted">Once it looks right, the integration uses it: the theme file in your pull request, and the tokens your coding agent can fetch.</p>
        </>
      ) : <div className="empty">No design extracted yet.</div>}
    </div>
  );
}
