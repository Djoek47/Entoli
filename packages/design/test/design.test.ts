import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { contrast, describeTokens, ensureContrast, ENTOLI_TOKENS, extractStatic, mergeTokens, normalizeColor, onColor, parseColor, sampleRuntime, themeCss, tweakTokens } from '../src/index.js';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'entoli-design-'));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) { await mkdir(dirname(join(root, p)), { recursive: true }); await writeFile(join(root, p), c); }
  return root;
}

describe('colour', () => {
  it('reads every common way CSS writes a colour', () => {
    expect(normalizeColor('#FA0')).toBe('#ffaa00');
    expect(normalizeColor('rgb(37, 99, 235)')).toBe('#2563eb');
    expect(normalizeColor('rgb(37 99 235 / 0.5)', { r: 255, g: 255, b: 255, a: 1 })).toBe('#92b1f5');
    expect(normalizeColor('hsl(221.2, 83.2%, 53.3%)')).toBe('#2563eb');
    expect(normalizeColor('221.2 83.2% 53.3%')).toBe('#2563eb');       // shadcn-style triple
    expect(normalizeColor('transparent')).toBeNull();
    expect(normalizeColor('var(--x)')).toBeNull();
    expect(parseColor('rebeccapurple')).toBeNull();
  });
  it('contrast: fixes an unreadable accent and picks readable text on it', () => {
    const lime = '#a6e01c';
    expect(contrast(parseColor(lime)!, parseColor('#fafaf7')!)).toBeLessThan(3);
    const text = ensureContrast(lime, '#fafaf7');
    expect(contrast(parseColor(text)!, parseColor('#fafaf7')!)).toBeGreaterThanOrEqual(4.5);
    expect(onColor('#a6e01c')).toBe('#0e0f0c');
    expect(onColor('#1e3a8a')).toBe('#ffffff');
  });
});

describe('translucent colours', () => {
  it('are blended over the background of their own mode, not over white', async () => {
    const root = await app({ 'src/styles.css': ':root{--paper:#fafaf7;--ink:#0e0f0c;--bg:#fafaf7;--line:rgba(14,15,12,.12);--muted:rgba(14,15,12,.6)}\n:root[data-theme=dark]{--bg:#0e0f0c;--ink:#fafaf7;--line:rgba(250,250,247,.14);--muted:rgba(250,250,247,.62)}' });
    const t = mergeTokens(extractStatic(root));
    expect(t.colors.border).toBe('#ddddda');   // dark ink at 12% over the light page
    expect(t.dark!.border).toBe('#2f302d');    // light ink at 14% over the DARK page (was near-white)
    expect(t.dark!.muted).toBe('#a0a19e');
    expect(contrast(parseColor(t.dark!.muted!)!, parseColor(t.dark!.background!)!)).toBeGreaterThan(4.5);
  });
  it('knows the common short names (--display, --mono, --dim, --warn)', async () => {
    const r = extractStatic(await app({ 'a.css': ':root{--display:"Sora",sans-serif;--mono:"JetBrains Mono",monospace;--body:"Hanken Grotesk",sans-serif;--dim:#555a66;--warn:#b42318}' }));
    expect(r.fonts).toMatchObject({ display: '"Sora",sans-serif'.replace(',', ', '), mono: '"JetBrains Mono", monospace', body: '"Hanken Grotesk", sans-serif' });
    expect(r.colors).toMatchObject({ muted: '#555a66', danger: '#b42318' });
  });
});

describe('static extraction: three kinds of app', () => {
  it('plain CSS variables, with a dark mode and @font-face', async () => {
    const root = await app({
      'src/index.css': `@font-face { font-family: "Recoleta"; src: url(r.woff2); }
        :root { --bg: #fffdf8; --fg: #1b1b1b; --brand: #c2410c; --muted: #7a7a7a; --line: #e7e0d4; --card: #ffffff; --danger: #b91c1c; --radius: 10px; --font-body: "Inter", sans-serif; --font-display: "Recoleta", serif; --font-mono: "Fira Code", monospace; }
        [data-theme="dark"] { --bg: #14110f; --fg: #f4efe8; --brand: #fb923c; }
        @media (prefers-color-scheme: dark) { :root { --card: #1d1916; } }
        body { margin: 0; }`,
    });
    const r = extractStatic(root);
    expect(r.colors).toMatchObject({ background: '#fffdf8', foreground: '#1b1b1b', accent: '#c2410c', muted: '#7a7a7a', border: '#e7e0d4', surface: '#ffffff', danger: '#b91c1c' });
    expect(r.fonts).toMatchObject({ body: '"Inter", sans-serif', display: '"Recoleta", serif', mono: '"Fira Code", monospace' });
    expect(r.radius).toBe(10);
    expect(r.dark).toMatchObject({ background: '#14110f', foreground: '#f4efe8', accent: '#fb923c', surface: '#1d1916' });
    expect(r.sources!['colors.accent']).toBe('src/index.css (--brand)');
  });

  it('Tailwind + shadcn: colours defined as hsl(var(--x)), fonts and radius in the config', async () => {
    const root = await app({
      'app/globals.css': `:root { --background: 0 0% 100%; --foreground: 222.2 47.4% 11.2%; --primary: 221.2 83.2% 53.3%; --muted-foreground: 215.4 16.3% 46.9%; --border: 214.3 31.8% 91.4%; --card: 0 0% 100%; --destructive: 0 84.2% 60.2%; --radius: 0.5rem; }
        .dark { --background: 222.2 84% 4.9%; --foreground: 210 40% 98%; --primary: 217.2 91.2% 59.8%; }`,
      'tailwind.config.ts': `export default { theme: { extend: {
        colors: { background: 'hsl(var(--background))', foreground: 'hsl(var(--foreground))', primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'white' } },
        fontFamily: { sans: ['Geist', 'system-ui', 'sans-serif'], mono: ['Geist Mono', 'monospace'] },
        borderRadius: { lg: 'var(--radius)' } } } };`,
    });
    const r = extractStatic(root);
    expect(r.colors).toMatchObject({ background: '#ffffff', foreground: '#0f172a', accent: '#2563eb', muted: '#64748b', border: '#e2e8f0', danger: '#ef4444' });
    expect(r.fonts).toMatchObject({ body: "Geist, system-ui, sans-serif", mono: "'Geist Mono', monospace" });
    expect(r.radius).toBe(8);
    expect(r.dark).toMatchObject({ background: '#020817', foreground: '#f8fafc', accent: '#3b82f6' });
  });

  it('CSS-in-JS: a MUI theme, a Chakra theme and a styled-components global style', async () => {
    const mui = await app({
      'src/theme.ts': `import { createTheme } from '@mui/material';
        export const theme = createTheme({ palette: { primary: { main: '#6d28d9' }, background: { default: '#f5f3ff', paper: '#ffffff' }, text: { primary: '#1e1b4b', secondary: '#6b7280' }, error: { main: '#dc2626' }, divider: '#ddd6fe' },
          typography: { fontFamily: '"Poppins", sans-serif' }, shape: { borderRadius: 12 } });`,
    });
    const a = extractStatic(mui);
    expect(a.colors).toMatchObject({ accent: '#6d28d9', background: '#f5f3ff', surface: '#ffffff', foreground: '#1e1b4b', muted: '#6b7280', danger: '#dc2626', border: '#ddd6fe' });
    expect(a.fonts!.body).toBe('"Poppins", sans-serif');
    expect(a.radius).toBe(12);

    const chakra = await app({
      'src/theme.js': `export default extendTheme({ colors: { brand: { 500: '#0891b2' }, background: '#ffffff' }, fonts: { heading: 'Space Grotesk', body: 'Inter', mono: 'JetBrains Mono' }, radii: { md: '6px' } });`,
    });
    const b = extractStatic(chakra);
    expect(b.colors).toMatchObject({ accent: '#0891b2', background: '#ffffff' });
    expect(b.fonts).toMatchObject({ display: "'Space Grotesk', system-ui, sans-serif", body: 'Inter, system-ui, sans-serif', mono: "'JetBrains Mono', system-ui, sans-serif" });
    expect(b.radius).toBe(6);

    const sc = await app({ 'src/GlobalStyle.ts': "export const GlobalStyle = createGlobalStyle`:root { --primary: #be123c; --background: #fff1f2; } body { font-family: 'Lora', serif; }`;" });
    const c = extractStatic(sc);
    expect(c.colors).toMatchObject({ accent: '#be123c', background: '#fff1f2' });
    expect(c.fonts!.body).toBe("'Lora', serif");
  });

  it('falls back to font imports in HTML, and says what it did not find', async () => {
    const root = await app({ 'index.html': '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400&family=DM+Serif+Display&display=swap" rel="stylesheet">' });
    const r = extractStatic(root);
    expect(r.fonts).toMatchObject({ body: "'DM Sans', system-ui, sans-serif", display: "'DM Serif Display', system-ui, sans-serif" });
    expect(r.colors).toEqual({});
    const t = mergeTokens(r);
    expect(t.colors.accent).toBe(ENTOLI_TOKENS.colors.accent);
    expect(t.sources['colors.accent']).toBe('default');
    expect(t.sources['fonts.body']).toBe('font import');
  });
});

describe('merge, derive, tweak, theme', () => {
  const t = mergeTokens({ colors: { background: '#101418', foreground: '#e8eaed', accent: '#7c3aed' }, fonts: { body: 'Georgia, serif' }, radius: 6, sources: { 'colors.accent': 'runtime: button' } });

  it('derives what the app does not define from what it does (a dark app gets a dark card, readable muted text)', () => {
    expect(t.colors.surface).toBe('#101418');
    expect(t.sources['colors.surface']).toBe('derived');
    expect(contrast(parseColor(t.colors.muted)!, parseColor(t.colors.background)!)).toBeGreaterThanOrEqual(4.5);
    expect(t.fonts.display).toBe('Georgia, serif');         // follows the body font instead of clashing with Sora
    expect(t.sources['colors.accent']).toBe('runtime: button');
  });

  it('later layers win, so the running app overrides the code', () => {
    const m = mergeTokens({ colors: { accent: '#111111' } }, { colors: { accent: '#7c3aed' } });
    expect(m.colors.accent).toBe('#7c3aed');
  });

  it('understands short instructions, and says when it did not', () => {
    expect(tweakTokens(t, 'rounder').tokens.radius).toBe(12);
    expect(tweakTokens(t, 'sharper please').tokens.radius).toBe(0);
    expect(tweakTokens(t, 'no shadow').tokens.shadow).toBe('none');
    expect(tweakTokens(t, 'make the accent blue').tokens.colors.accent).toBe('#2563eb');
    expect(tweakTokens(t, 'use #ff6600 as the accent').tokens.colors.accent).toBe('#ff6600');
    expect(tweakTokens(t, 'make the background white').tokens.colors.background).toBe('#ffffff');
    expect(tweakTokens(t, 'rounder and no shadow').changes).toHaveLength(2);
    expect(tweakTokens(t, 'rounder').tokens.sources.radius).toBe('voice');
    expect(tweakTokens(t, 'purple monkey dishwasher').unknown).toBe('purple monkey dishwasher');
  });

  it('generates the theme: variables, a readable accent text, a dark variant when the app has one', () => {
    const css = themeCss({ ...t, dark: { background: '#000000', foreground: '#ffffff' } });
    expect(css).toContain('--e-ink:#e8eaed');
    expect(css).toContain('--e-lime:#7c3aed');
    expect(css).toContain('--e-on-accent:#ffffff');
    expect(css).toContain('--e-radius:6px');
    expect(css).toContain("--e-font:Georgia, serif");
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain('.dark .entoli');
    expect(describeTokens(t)).toMatch(/Georgia for text and Georgia for headings, #7c3aed accent on #101418, 6px corners/);
  });
});

// ---- the real thing: a running page, sampled in Chromium, and the real Entoli bar themed from it ----------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #101418; color: #e8eaed; font-family: Georgia, serif; }
  h1 { font-family: "Courier New", monospace; font-size: 22px; margin: 0 0 12px; }
  .muted { color: #8b95a1; }
  .card { background: #1a2027; border: 1px solid #2c3640; border-radius: 6px; padding: 12px; box-shadow: 4px 4px 0 #000; margin: 12px 0; }
  button { background: #7c3aed; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; }
  input { background: #101418; color: #e8eaed; border: 1px solid #2c3640; border-radius: 6px; padding: 6px; }
  a { color: #38bdf8; }
</style></head><body>
  <h1>Studio</h1><p class="muted">Small print</p>
  <div class="card"><input placeholder="name"> <button>Save</button> <a href="#">link</a></div>
  <div id="bar" style="max-width:640px"></div>
</body></html>`;

describe('runtime sampling and the themed bar, in real Chromium', () => {
  it('samples the page as people see it, then the REAL Entoli bar looks native', async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as { chromium: { launch(o?: object): Promise<{ newPage(): Promise<any>; close(): Promise<void> }> } };
    const exe = process.env.ENTOLI_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {});
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const sampled = await sampleRuntime(page);
      expect(sampled.colors).toMatchObject({ background: '#101418', foreground: '#e8eaed', accent: '#7c3aed', muted: '#8b95a1', border: '#2c3640' });
      expect(sampled.fonts).toMatchObject({ body: 'Georgia, serif' });
      expect(sampled.fonts!.display).toContain('Courier New');
      expect(sampled.radius).toBe(6);
      expect(sampled.shadow).toBe('hard');
      expect(sampled.sources!['colors.accent']).toMatch(/^runtime: button/);

      const tokens = mergeTokens(sampled);
      const bundle = readFileSync(fileURLToPath(new URL('../../sdk/dist/entoli.min.js', import.meta.url)), 'utf8');
      await page.addStyleTag({ content: themeCss(tokens) });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(`(() => {
        const skill = { entoli: '0.1', app: { name: 'Studio' }, layer: 'L1', mode: 'text', map: [], knowledge: [],
          acts: [{ name: 'email.change', title: 'Change email', phrases: ['change email'], radius: 'external', exact: true, slots: { email: { type: 'freeText', required: true } } }] };
        Entoli.defineAct('email.change', { email: 'freeText' }, () => {}, {});
        window.__e = Entoli.mount({ el: document.getElementById('bar'), skill, fonts: false });
        window.__e.hear('change email to a@b.co');
      })()`);
      await page.waitForSelector('.entoli-btn.go');

      const style = (sel: string, prop: string) => page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}]`) as Promise<string>;
      // The bar sits on the app's own surface, in the app's own radius and ink.
      expect(await style('.entoli-bar', 'backgroundColor')).toBe('rgb(16, 20, 24)');
      expect(await style('.entoli-bar', 'borderTopLeftRadius')).toBe('6px');
      expect(await style('.entoli-bar', 'borderTopColor')).toBe('rgb(232, 234, 237)');
      // Headings use the app's heading font; text the app's body font.
      expect(await style('.entoli-title', 'fontFamily')).toContain('Courier New');
      expect(await style('.entoli', 'fontFamily')).toContain('Georgia');
      // The confirm button is the app's accent with readable text, and the exact card carries the app's hard shadow.
      expect(await style('.entoli-btn.go', 'backgroundColor')).toBe('rgb(124, 58, 237)');
      expect(await style('.entoli-btn.go', 'color')).toBe('rgb(255, 255, 255)');
      expect(await style('.entoli-card', 'boxShadow')).toContain('rgb(232, 234, 237) 4px 4px 0px');

      const out = process.env.ENTOLI_SHOT;
      if (out) await page.screenshot({ path: out });
    } finally {
      await browser.close();
    }
  }, 120_000);
});
