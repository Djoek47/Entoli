/**
 * Read an app's design system from its code, without running it.
 *
 * Sources: CSS/SCSS (custom properties in :root and dark selectors, body
 * declarations, radii on cards and buttons, @font-face), Tailwind config,
 * theme objects (MUI createTheme, Chakra extendTheme, styled-components
 * themes: any `palette` / `colors` / `fonts` / `typography` / `radii` object),
 * styled-components/emotion global styles, and font links in HTML.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { normalizeColorAlpha, parseColor } from './color.js';
import type { Colors, PartialTokens } from './tokens.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.turbo', '.vercel', 'vendor', 'public', '.cache']);
const MAX_FILES = 400;
const MAX_BYTES = 400_000;

// ---- role names ---------------------------------------------------------------------------------

type Role = `colors.${keyof Colors}` | 'fonts.body' | 'fonts.display' | 'fonts.mono' | 'radius';

const ROLES: Record<Role, string[]> = {
  'colors.background': ['background', 'bg', 'page-bg', 'background-color', 'bg-color', 'body-bg', 'app-bg', 'color-background', 'color-bg', 'surface-0', 'paper', 'canvas', 'bg-primary', 'page'],
  'colors.foreground': ['foreground', 'fg', 'text', 'text-color', 'color-text', 'text-primary', 'ink', 'body-color', 'color-foreground', 'on-background'],
  'colors.accent': ['primary', 'accent', 'brand', 'brand-primary', 'primary-color', 'accent-color', 'color-primary', 'color-accent', 'brand-color', 'link', 'link-color', 'highlight'],
  'colors.muted': ['muted-foreground', 'text-muted', 'muted', 'dim', 'text-dim-color', 'text-secondary', 'text-dim', 'subtle', 'secondary-text', 'color-muted', 'text-subtle'],
  'colors.border': ['border', 'border-color', 'line', 'divider', 'outline', 'color-border', 'border-default', 'stroke', 'hairline'],
  'colors.surface': ['card', 'surface', 'panel', 'elevated', 'surface-1', 'bg-card', 'card-bg', 'popover', 'background-secondary', 'bg-secondary', 'bg-elevated', 'color-surface'],
  'colors.danger': ['destructive', 'danger', 'error', 'negative', 'warn', 'warning-text', 'color-danger', 'color-error', 'color-destructive', 'red'],
  'fonts.body': ['font-sans', 'font-body', 'body', 'sans', 'font-main', 'font-base', 'font-family', 'font', 'font-text', 'font-primary', 'font-family-base', 'font-family-sans'],
  'fonts.display': ['font-display', 'display', 'heading', 'headings', 'font-heading', 'font-headings', 'font-title', 'font-head', 'font-family-heading', 'font-serif'],
  'fonts.mono': ['font-mono', 'mono', 'font-code', 'font-monospace', 'font-family-mono', 'font-family-code'],
  radius: ['radius', 'border-radius', 'radius-md', 'radius-lg', 'radius-base', 'rounded', 'radius-card', 'corner-radius', 'r'],
};

function roleOf(rawName: string): { role: Role; rank: number } | null {
  const name = rawName.toLowerCase().replace(/^--/, '').replace(/_/g, '-');
  const tries = [name, name.includes('-') ? name.split('-').slice(1).join('-') : ''];
  for (const [i, n] of tries.entries()) {
    if (!n) continue;
    for (const [role, names] of Object.entries(ROLES) as [Role, string[]][]) {
      const at = names.indexOf(n);
      if (at >= 0) return { role, rank: at + i * 20 };
    }
  }
  return null;
}

// ---- values -------------------------------------------------------------------------------------------

type Vars = Record<string, string>;

function resolveVars(value: string, vars: Vars, depth = 0): string {
  if (depth > 5) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) => resolveVars(vars[name] ?? fallback ?? '', vars, depth + 1)).replace(/<alpha-value>/g, '1');
}

function colorOf(value: string, vars: Vars): string | null {
  const v = resolveVars(value.trim(), vars);
  const direct = normalizeColorAlpha(v);
  if (direct) return direct;
  const inner = /(#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\))/i.exec(v)?.[1];
  return inner ? normalizeColorAlpha(inner) : null;
}

function px(value: string, vars: Vars = {}): number | null {
  const v = resolveVars(value.trim(), vars);
  const m = /^(-?[\d.]+)\s*(px|rem|em)?$/.exec(v);
  if (!m) return /\bfull\b/.test(v) ? 24 : null;
  const n = parseFloat(m[1]!);
  return m[2] === 'rem' || m[2] === 'em' ? Math.round(n * 16) : Math.round(n);
}

const GENERIC = /\b(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy)\b/;

export function fontStack(value: string, vars: Vars = {}): string | null {
  const v = resolveVars(value, vars).trim().replace(/;$/, '');
  if (!v || /^(inherit|initial|unset)$/i.test(v)) return null;
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean).map((p) => (/^['"]/.test(p) || /^[\w-]+$/.test(p) || p.startsWith('var(') ? p : `'${p}'`));
  const stack = parts.map((p) => (/\s/.test(p) && !/^['"]/.test(p) ? `'${p}'` : p));
  if (!stack.length) return null;
  return GENERIC.test(v) ? stack.join(', ') : `${stack.join(', ')}, system-ui, sans-serif`;
}

// ---- CSS ---------------------------------------------------------------------------------------------

type Block = { selector: string; atRules: string[]; body: string };

function cssBlocks(css: string, fontFaces: string[]): Block[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Block[] = [];
  const parse = (src: string, at: string[]) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(Math.max(src.lastIndexOf(';', open), src.lastIndexOf('}', open), i - 1) + 1, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const inner = src.slice(open + 1, j - 1);
      if (head.startsWith('@font-face')) { const f = /font-family\s*:\s*([^;]+)/.exec(inner)?.[1]; if (f) fontFaces.push(f.trim().replace(/^['"]|['"]$/g, '')); }
      else if (head.startsWith('@keyframes') || head.startsWith('@-webkit-keyframes')) { /* skip */ }
      else if (head.startsWith('@')) parse(inner, [...at, head]);
      else out.push({ selector: head, atRules: at, body: inner });
      i = j;
    }
  };
  parse(text, []);
  return out;
}

function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { push(cur); cur = ''; } else cur += ch;
  }
  push(cur);
  function push(d: string) { const k = d.indexOf(':'); if (k > 0) out.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()]); }
  return out;
}

const DARK_SEL = /(\.dark\b|\.theme-dark|\[data-theme=["']?dark|\[data-mode=["']?dark|\[data-bs-theme=["']?dark|\.dark-mode|\.is-dark)/i;
const isDark = (b: Block) => b.atRules.some((a) => /prefers-color-scheme\s*:\s*dark/i.test(a)) || DARK_SEL.test(b.selector);
const isRoot = (b: Block) => b.selector.split(',').some((s) => /^(:root|html|body|\*|\.dark|\.theme-dark)\b|^\[data-/.test(s.trim()));

// ---- collection -----------------------------------------------------------------------------------------

type Cand = { value: string; rank: number; source: string };

class Collector {
  cands = new Map<string, Cand>();
  dark = new Map<string, Cand>();
  vars: Vars = {};
  darkVars: Vars = {};
  radii: number[] = [];
  fonts: string[] = [];
  bodyBg?: Cand;
  bodyColor?: Cand;
  bodyFont?: Cand;

  offer(into: Map<string, Cand>, role: Role, c: Cand) {
    const prev = into.get(role);
    if (!prev || c.rank < prev.rank) into.set(role, c);
  }
}

function fromCss(col: Collector, text: string, file: string) {
  const faces: string[] = [];
  const blocks = cssBlocks(text, faces);
  col.fonts.push(...faces);
  const bonus = /(^|\/)(index|globals?|base|main|app|styles?|theme|variables|tokens)\.(s?css|less)$/i.test(file) ? -0.5 : 0;
  // custom properties first, so later references resolve
  for (const b of blocks) {
    if (!isRoot(b) && !isDark(b)) continue;
    for (const [k, v] of declarations(b.body)) if (k.startsWith('--')) (isDark(b) ? col.darkVars : col.vars)[k] = v;
  }
  for (const b of blocks) {
    const dark = isDark(b);
    for (const [k, v] of declarations(b.body)) {
      if (k.startsWith('--') && (isRoot(b) || dark)) {
        const r = roleOf(k);
        if (!r) continue;
        const into = dark ? col.dark : col.cands;
        const src = `${file} (${k})`;
        if (r.role.startsWith('colors.')) { const c = colorOf(v, dark ? { ...col.vars, ...col.darkVars } : col.vars); if (c) col.offer(into, r.role, { value: c, rank: r.rank + bonus, source: src }); }
        else if (r.role.startsWith('fonts.')) { const f = fontStack(v, col.vars); if (f && !dark) col.offer(into, r.role, { value: f, rank: r.rank + bonus, source: src }); }
        else if (r.role === 'radius' && !dark) { const n = px(v, col.vars); if (n !== null) col.offer(into, r.role, { value: String(n), rank: r.rank + bonus, source: src }); }
      } else if (!dark && /^(body|html)\b/.test(b.selector.trim())) {
        if (k === 'font-family') { const f = fontStack(v, col.vars); if (f && !col.bodyFont) col.bodyFont = { value: f, rank: 0, source: `${file} (body)` }; }
        else if (k === 'background' || k === 'background-color') { const c = colorOf(v, col.vars); if (c && !col.bodyBg) col.bodyBg = { value: c, rank: 0, source: `${file} (body)` }; }
        else if (k === 'color') { const c = colorOf(v, col.vars); if (c && !col.bodyColor) col.bodyColor = { value: c, rank: 0, source: `${file} (body)` }; }
      } else if (k === 'border-radius' && !dark && /(\.|^|\s)(card|btn|button|panel|input)\b|^button\b|^input\b/.test(b.selector)) {
        const n = px(v.split(/\s+/)[0]!, col.vars);
        if (n !== null && n < 40) col.radii.push(n);
      }
    }
  }
}

// ---- theme objects (Tailwind, MUI, Chakra, styled-components) ------------------------------------------------

function litText(e: ts.Node | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return e.text;
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return `-${e.operand.text}`;
  return undefined;
}
const keyOf = (p: ts.PropertyAssignment) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : '');
const objProps = (e: ts.Expression | undefined) => (e && ts.isObjectLiteralExpression(e) ? e.properties.filter(ts.isPropertyAssignment) : []);

/** { primary: { DEFAULT: '#…', 500: '#…' }, background: '#…' } → { primary: '#…', background: '#…' } */
function flattenColors(e: ts.Expression | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of objProps(e)) {
    const k = keyOf(p);
    const s = litText(p.initializer);
    if (s !== undefined) { out[k] = s; continue; }
    const inner = objProps(p.initializer);
    const pick = inner.find((q) => ['DEFAULT', 'main', '500', 'base', '600'].includes(keyOf(q)));
    const v = pick ? litText(pick.initializer) : undefined;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function fontList(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const s = litText(e);
  if (s !== undefined) return s;
  if (ts.isArrayLiteralExpression(e)) {
    const names = e.elements.map(litText).filter((x): x is string => !!x);
    return names.length ? names.map((n) => (/\s/.test(n) && !/^['"]/.test(n) ? `'${n}'` : n)).join(', ') : null;
  }
  return null;
}

function fromTheme(col: Collector, text: string, file: string, kind: ts.ScriptKind) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const offer = (role: Role, value: string, rank: number, what: string) => col.offer(col.cands, role, { value, rank, source: `${file} (${what})` });
  const colorRole = (name: string, value: string, what: string) => {
    const r = roleOf(name);
    const c = colorOf(value, col.vars);
    if (r?.role.startsWith('colors.') && c) offer(r.role, c, r.rank + 2, what);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n)) {
      const key = keyOf(n);
      if (key === 'colors') for (const [k, v] of Object.entries(flattenColors(n.initializer))) colorRole(k, v, `colors.${k}`);
      else if (key === 'palette') {
        const p = Object.fromEntries(objProps(n.initializer).map((q) => [keyOf(q), q.initializer]));
        const get = (a: string, b: string) => litText(objProps(p[a]).find((q) => keyOf(q) === b)?.initializer);
        const set = (role: Role, v: string | undefined, what: string) => { const c = v ? colorOf(v, col.vars) : null; if (c) offer(role, c, 1, what); };
        set('colors.accent', get('primary', 'main'), 'palette.primary.main');
        set('colors.background', get('background', 'default'), 'palette.background.default');
        set('colors.surface', get('background', 'paper'), 'palette.background.paper');
        set('colors.foreground', get('text', 'primary'), 'palette.text.primary');
        set('colors.muted', get('text', 'secondary'), 'palette.text.secondary');
        set('colors.border', litText(p.divider), 'palette.divider');
        set('colors.danger', get('error', 'main'), 'palette.error.main');
      } else if (key === 'fontFamily' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const q of objProps(n.initializer)) {
          const k = keyOf(q).toLowerCase(); const f = fontList(q.initializer);
          const stack = f ? fontStack(f, col.vars) : null;
          if (!stack) continue;
          if (['sans', 'body', 'base', 'text'].includes(k)) offer('fonts.body', stack, 1, `fontFamily.${k}`);
          else if (['display', 'heading', 'headings', 'serif', 'title'].includes(k)) offer('fonts.display', stack, 1, `fontFamily.${k}`);
          else if (k === 'mono' || k === 'code') offer('fonts.mono', stack, 1, `fontFamily.${k}`);
        }
      } else if (key === 'fonts' && ts.isObjectLiteralExpression(n.initializer)) {
        for (const q of objProps(n.initializer)) {
          const k = keyOf(q).toLowerCase(); const f = fontList(q.initializer); const stack = f ? fontStack(f, col.vars) : null;
          if (!stack) continue;
          if (k === 'body' || k === 'sans') offer('fonts.body', stack, 1, `fonts.${k}`);
          else if (k === 'heading' || k === 'display') offer('fonts.display', stack, 1, `fonts.${k}`);
          else if (k === 'mono') offer('fonts.mono', stack, 1, `fonts.${k}`);
        }
      } else if (key === 'typography' && ts.isObjectLiteralExpression(n.initializer)) {
        const f = fontList(objProps(n.initializer).find((q) => keyOf(q) === 'fontFamily')?.initializer);
        const stack = f ? fontStack(f, col.vars) : null;
        if (stack) offer('fonts.body', stack, 1, 'typography.fontFamily');
      } else if (key === 'borderRadius' || key === 'radii') {
        const s = litText(n.initializer);
        if (s !== undefined) { const v = px(/^\d+$/.test(s) ? `${s}px` : s); if (v !== null) offer('radius', String(v), 1, key); }
        else {
          const q = objProps(n.initializer).find((x) => ['DEFAULT', 'md', 'lg', 'base'].includes(keyOf(x)));
          const t = q ? litText(q.initializer) : undefined;
          const v = t !== undefined ? px(t) : null;
          if (v !== null) offer('radius', String(v), 2, `${key}.${keyOf(q!)}`);
        }
      } else if (key === 'shape') {
        const b = objProps(n.initializer).find((q) => keyOf(q) === 'borderRadius');
        const t = b ? litText(b.initializer) : undefined;
        if (t !== undefined) offer('radius', t, 1, 'shape.borderRadius');
      }
    }
    // styled-components / emotion global styles
    if (ts.isTaggedTemplateExpression(n) && ts.isNoSubstitutionTemplateLiteral(n.template) && /^(createGlobalStyle|injectGlobal|css|globalCss)$/.test(n.tag.getText(sf))) fromCss(col, n.template.text, `${file} (${n.tag.getText(sf)})`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---- html --------------------------------------------------------------------------------------------------------

function fromHtml(col: Collector, text: string, file: string) {
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) fromCss(col, m[1]!, file);
  for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/g)) {
    for (const f of m[1]!.matchAll(/family=([^&:;]+)/g)) col.fonts.push(decodeURIComponent(f[1]!.replace(/\+/g, ' ')));
  }
}

// ---- main -----------------------------------------------------------------------------------------------------------

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP.has(name) && !name.startsWith('.')) stack.push(p); continue; }
      if (st.size > MAX_BYTES) continue;
      if (/\.(css|scss|less|html)$/.test(name) || /^tailwind\.config\.[cm]?[jt]s$/.test(name) || (/\.(tsx?|jsx?)$/.test(name) && /theme|style|tokens|global|palette|design/i.test(name))) out.push(p);
    }
  }
  return out;
}

export type StaticResult = PartialTokens & { files: number; fontsImported: string[] };

export function extractStatic(rootDir: string): StaticResult {
  const files = walk(rootDir);
  const col = new Collector();
  const rel = (f: string) => relative(rootDir, f).split(sep).join('/');
  // CSS and HTML first, so theme objects can resolve var(--x) references.
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/\.(css|scss|less)$/.test(f)) fromCss(col, text, rel(f));
    else if (f.endsWith('.html')) fromHtml(col, text, rel(f));
  }
  for (const f of files) {
    if (!/\.(tsx?|jsx?|[cm]js)$/.test(f)) continue;
    const kind = f.endsWith('x') ? ts.ScriptKind.TSX : extname(f) === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    try { fromTheme(col, readFileSync(f, 'utf8'), rel(f), kind); } catch { /* unparseable theme file: skip */ }
  }

  const out: StaticResult = { files: files.length, fontsImported: [...new Set(col.fonts)], colors: {}, fonts: {}, sources: {} };
  const put = (role: Role, c: Cand) => {
    out.sources![role] = c.source;
    if (role.startsWith('colors.')) (out.colors as Record<string, string>)[role.slice(7)] = c.value;
    else if (role.startsWith('fonts.')) (out.fonts as Record<string, string>)[role.slice(6)] = c.value;
    else out.radius = Number(c.value);
  };
  for (const [role, c] of col.cands) put(role as Role, c);
  // Declarations on body are what people see; they fill in what the named variables did not.
  if (!col.cands.has('colors.background') && col.bodyBg) put('colors.background', col.bodyBg);
  if (!col.cands.has('colors.foreground') && col.bodyColor) put('colors.foreground', col.bodyColor);
  if (!col.cands.has('fonts.body') && col.bodyFont) put('fonts.body', col.bodyFont);
  if (out.radius === undefined && col.radii.length) {
    const sorted = [...col.radii].sort((a, b) => a - b);
    out.radius = sorted[Math.floor(sorted.length / 2)]!;
    out.sources!.radius = 'css (border-radius on cards and buttons)';
  }
  // Only a font import to go on: the first family is the body font.
  if (!out.fonts!.body && out.fontsImported[0]) { out.fonts!.body = fontStack(out.fontsImported[0])!; out.sources!['fonts.body'] = 'font import'; }
  if (!out.fonts!.display && out.fontsImported[1] && out.fonts!.body && out.sources!['fonts.body'] === 'font import') { out.fonts!.display = fontStack(out.fontsImported[1])!; out.sources!['fonts.display'] = 'font import'; }

  if (col.dark.size) {
    out.dark = {};
    for (const [role, c] of col.dark) if (role.startsWith('colors.')) { (out.dark as Record<string, string>)[role.slice(7)] = c.value; out.sources![`dark.${role.slice(7)}`] = c.source; }
  }
  // Keep only valid values.
  for (const k of Object.keys(out.colors ?? {})) if (!parseColor((out.colors as Record<string, string>)[k])) delete (out.colors as Record<string, string>)[k];
  return out;
}
