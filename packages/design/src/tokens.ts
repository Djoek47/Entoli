/**
 * One set of design tokens per app, and how they are merged, tweaked and turned
 * into the Entoli theme.
 */
import { contrast, ensureContrast, mix, normalizeColor, normalizeColorAlpha, onColor, over, parseColor, shift, toHex } from './color.js';

export type Colors = { background: string; foreground: string; accent: string; muted: string; border: string; surface: string; danger: string };

export type DesignTokens = {
  colors: Colors;
  /** The dark-mode counterpart, when the app has one (only the colours it defines). */
  dark?: Partial<Colors>;
  /** CSS font-family stacks. */
  fonts: { body: string; display: string; mono: string };
  /** Corner radius in px, for cards and the bar. */
  radius: number;
  shadow: 'none' | 'soft' | 'hard';
  /** Where each token came from, e.g. { 'colors.accent': 'runtime: button' }. 'default' = not found, Entoli's own. */
  sources: Record<string, string>;
};

/** Entoli's own brand: what is used for anything the app does not define. */
export const ENTOLI_TOKENS: DesignTokens = {
  colors: { background: '#fafaf7', foreground: '#0e0f0c', accent: '#a6e01c', muted: '#6b6c68', border: '#dedfdb', surface: '#ffffff', danger: '#b42318' },
  fonts: { body: "'Hanken Grotesk', system-ui, sans-serif", display: "'Sora', system-ui, sans-serif", mono: "'JetBrains Mono', ui-monospace, monospace" },
  radius: 14,
  shadow: 'hard',
  sources: {},
};

export type PartialTokens = {
  colors?: Partial<Colors>;
  dark?: Partial<Colors>;
  fonts?: Partial<DesignTokens['fonts']>;
  radius?: number;
  shadow?: DesignTokens['shadow'];
  sources?: Record<string, string>;
};

/**
 * Combine what the code says with what the running app shows. The runtime wins
 * for what people actually see (colours, fonts, radius, shadow); the code is
 * the only source for dark mode.
 */
export function mergeTokens(...layers: (PartialTokens | undefined)[]): DesignTokens {
  const out: DesignTokens = JSON.parse(JSON.stringify(ENTOLI_TOKENS));
  for (const k of Object.keys(out.colors)) out.sources[`colors.${k}`] = 'default';
  for (const k of Object.keys(out.fonts)) out.sources[`fonts.${k}`] = 'default';
  out.sources.radius = 'default';
  out.sources.shadow = 'default';
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l.colors ?? {})) {
      const n = normalizeColorAlpha(v);
      if (n) { (out.colors as Record<string, string>)[k] = n; out.sources[`colors.${k}`] = l.sources?.[`colors.${k}`] ?? 'given'; }
    }
    for (const [k, v] of Object.entries(l.dark ?? {})) {
      const n = normalizeColorAlpha(v);
      if (n) { out.dark = { ...(out.dark ?? {}), [k]: n }; out.sources[`dark.${k}`] = l.sources?.[`dark.${k}`] ?? 'given'; }
    }
    for (const [k, v] of Object.entries(l.fonts ?? {})) if (v) { (out.fonts as Record<string, string>)[k] = v; out.sources[`fonts.${k}`] = l.sources?.[`fonts.${k}`] ?? 'given'; }
    if (typeof l.radius === 'number' && Number.isFinite(l.radius)) { out.radius = Math.min(32, Math.max(0, Math.round(l.radius))); out.sources.radius = l.sources?.radius ?? 'given'; }
    if (l.shadow) { out.shadow = l.shadow; out.sources.shadow = l.sources?.shadow ?? 'given'; }
  }
  // Translucent colours are blended over the background of THEIR mode, now that it is known.
  out.colors.background = over(out.colors.background, '#ffffff');
  for (const k of Object.keys(out.colors) as (keyof Colors)[]) if (k !== 'background') out.colors[k] = over(out.colors[k], out.colors.background);
  if (out.dark) {
    const darkBg = over(out.dark.background ?? out.colors.background, '#000000');
    if (out.dark.background) out.dark.background = darkBg;
    for (const k of Object.keys(out.dark) as (keyof Colors)[]) if (k !== 'background') out.dark[k] = over(out.dark[k]!, darkBg);
  }
  // Colours the app does not define are derived from the ones it does, so a dark app never gets a white default card.
  const bg = parseColor(out.colors.background)!, fg = parseColor(out.colors.foreground)!;
  const derive = (k: keyof Colors, v: string) => { if (out.sources[`colors.${k}`] === 'default') { out.colors[k] = v; out.sources[`colors.${k}`] = 'derived'; } };
  derive('surface', out.colors.background);
  derive('border', toHex(mix(fg, bg, 0.16)));
  derive('muted', ensureContrast(toHex(mix(fg, bg, 0.55)), out.colors.background, 4.5));
  // A display font that was not found follows the body font, rather than falling back to Sora against a foreign body font.
  if (out.sources['fonts.display'] === 'default' && out.sources['fonts.body'] !== 'default') { out.fonts.display = out.fonts.body; out.sources['fonts.display'] = 'follows body'; }
  if (out.sources['fonts.mono'] === 'default' && out.sources['fonts.body'] !== 'default') { /* mono keeps its own default: code is code */ }
  return out;
}

// ---- tweaks by instruction ("rounder", "use our blue as the accent") ----------------------------------

const COLOR_WORDS: Record<string, string> = { blue: '#2563eb', red: '#dc2626', green: '#16a34a', purple: '#7c3aed', orange: '#ea580c', pink: '#db2777', teal: '#0d9488', yellow: '#eab308', black: '#111111', white: '#ffffff', lime: '#a6e01c', indigo: '#4f46e5' };

export type Tweak = { tokens: DesignTokens; changes: string[]; unknown?: string };

/** Understands a short instruction: "rounder", "sharper", "no shadow", "darker", "lighter", "use #2563eb as the accent", "make the accent blue". */
export function tweakTokens(t: DesignTokens, instruction: string): Tweak {
  const s = instruction.toLowerCase();
  const out: DesignTokens = JSON.parse(JSON.stringify(t));
  const changes: string[] = [];
  const mark = (k: string) => { out.sources[k] = 'voice'; };

  if (/\b(rounder|more round|softer corners|pill)\b/.test(s)) { out.radius = Math.min(32, out.radius + (/pill/.test(s) ? 12 : 6)); mark('radius'); changes.push(`corners rounder (${out.radius}px)`); }
  if (/\b(sharper|squarer|square|less round|crisper)\b/.test(s)) { out.radius = Math.max(0, out.radius - 6); mark('radius'); changes.push(`corners sharper (${out.radius}px)`); }
  if (/\b(no shadow|flat|without shadow)\b/.test(s)) { out.shadow = 'none'; mark('shadow'); changes.push('no shadow'); }
  else if (/\b(softer shadow|soft shadow)\b/.test(s)) { out.shadow = 'soft'; mark('shadow'); changes.push('soft shadow'); }
  else if (/\b(hard shadow|bold shadow)\b/.test(s)) { out.shadow = 'hard'; mark('shadow'); changes.push('hard shadow'); }
  if (/\bdarker\b/.test(s)) { out.colors.accent = shift(out.colors.accent, -0.15); mark('colors.accent'); changes.push('accent darker'); }
  if (/\blighter\b/.test(s)) { out.colors.accent = shift(out.colors.accent, 0.15); mark('colors.accent'); changes.push('accent lighter'); }

  const hex = /#[0-9a-f]{3,8}\b/.exec(s)?.[0];
  const word = Object.keys(COLOR_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(s));
  const target = /\b(background|page)\b/.test(s) ? 'background' : /\b(text|foreground|ink)\b/.test(s) ? 'foreground' : /\b(border|line|outline)\b/.test(s) ? 'border' : /\b(accent|primary|brand|highlight|button)\b/.test(s) ? 'accent' : null;
  const color = hex ?? (word ? COLOR_WORDS[word] : undefined);
  if (color && (target || /\b(use|make|set|change)\b/.test(s))) {
    const k = (target ?? 'accent') as keyof Colors;
    const n = normalizeColor(color);
    if (n) { out.colors[k] = n; mark(`colors.${k}`); changes.push(`${k} ${n}`); }
  }
  const font = /\bfont (?:to |as )?["']?([a-z][a-z0-9 ]{1,30})["']?/.exec(s)?.[1]?.trim();
  if (font && !/^(bigger|smaller|larger)/.test(font)) {
    const name = font.replace(/\b\w/g, (c) => c.toUpperCase());
    out.fonts.body = `'${name}', ${out.fonts.body}`; out.fonts.display = `'${name}', ${out.fonts.display}`; mark('fonts.body'); mark('fonts.display'); changes.push(`font ${name}`);
  }
  return changes.length ? { tokens: out, changes } : { tokens: t, changes, unknown: instruction };
}

// ---- the Entoli theme --------------------------------------------------------------------------------------

function vars(c: Colors, t: DesignTokens, includeShape: boolean): string {
  const bg = c.background;
  // Accent as TEXT on the page background must be readable; as a fill it can stay vivid.
  const accentText = ensureContrast(c.accent, bg, 4.5);
  const lines = [
    `--e-ink:${c.foreground}`, `--e-paper:${c.surface}`,
    `--e-lime:${c.accent}`, `--e-lime-text:${accentText}`, `--e-on-accent:${onColor(c.accent)}`,
    `--e-line:${c.border}`, `--e-muted:${c.muted}`, `--e-warn:${ensureContrast(c.danger, bg, 3)}`,
  ];
  if (includeShape) {
    lines.push(`--e-font:${t.fonts.body}`, `--e-font-display:${t.fonts.display}`, `--e-font-mono:${t.fonts.mono}`, `--e-radius:${t.radius}px`);
    lines.push(`--e-shadow-exact:${t.shadow === 'none' ? 'none' : t.shadow === 'soft' ? `0 8px 24px color-mix(in srgb, ${c.foreground} 18%, transparent)` : `4px 4px 0 ${c.foreground}`}`);
  }
  return lines.join(';');
}

/** The CSS that makes the Entoli bar and card look native to the app. */
export function themeCss(t: DesignTokens): string {
  const light = vars(t.colors, t, true);
  let css = `/* Entoli theme, generated from this app's design system. Edit freely. */\n.entoli{${light}}\n`;
  if (t.dark && Object.keys(t.dark).length) {
    const dark = vars({ ...t.colors, ...t.dark }, t, false);
    css += `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]):not(.light) .entoli{${dark}}}\n:root[data-theme="dark"] .entoli,.dark .entoli{${dark}}\n`;
  }
  return css;
}

/** Readable summary for a person (and for the voice): "Sora headings, #2563eb accent, 8 px corners…". */
export function describeTokens(t: DesignTokens): string {
  const first = (f: string) => f.split(',')[0]!.replace(/['"]/g, '').trim();
  const found = Object.values(t.sources).filter((s) => s !== 'default' && s !== 'follows body' && s !== 'derived').length;
  return `${first(t.fonts.body)} for text and ${first(t.fonts.display)} for headings, ${t.colors.accent} accent on ${t.colors.background}, ${t.radius}px corners, ${t.shadow === 'none' ? 'no' : t.shadow} shadow${t.dark ? ', with a dark mode' : ''}. ${found} of ${Object.keys(t.sources).length} values came from your app.`;
}

export { contrast, mix, normalizeColor, parseColor, toHex };
