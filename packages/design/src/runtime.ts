/**
 * Sample the design system from the RUNNING app: what people actually see.
 * The script runs in the page and returns raw computed styles; the conversion
 * to tokens happens here.
 */
import { distance, mix, normalizeColor, parseColor, saturation, toHex, type RGBA } from './color.js';
import { fontStack } from './static.js';
import type { PartialTokens } from './tokens.js';

export type EvalPage = { evaluate<T>(script: string): Promise<T> };

type Raw = {
  bg: string; fg: string; bodyFont: string; headingFont: string | null; monoFont: string | null;
  buttons: { bg: string; color: string; sel: string }[]; link: string | null; muted: string | null;
  borders: string[]; radii: number[]; shadow: string | null;
};

/** Plain JavaScript source, run inside the page (a string, so no bundler can rewrite it). */
export const SAMPLE_SCRIPT = `(() => {
  const cs = (el) => getComputedStyle(el);
  const body = document.body, html = document.documentElement;
  let bg = cs(body).backgroundColor;
  if (!bg || /rgba\\(.*,\\s*0\\)|transparent/.test(bg)) bg = cs(html).backgroundColor;
  if (!bg || /rgba\\(.*,\\s*0\\)|transparent/.test(bg)) bg = 'rgb(255, 255, 255)';
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8; };
  const q = (sel, n = 12) => Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, n);
  const buttons = q('button, [type=submit], a[class*=btn], a[class*=button], [class*=primary], [class*=cta]', 20)
    .map((el) => ({ bg: cs(el).backgroundColor, color: cs(el).color, sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') }));
  const h = q('h1, h2, h3', 1)[0];
  const code = q('code, pre, kbd, [class*=mono]', 1)[0];
  const link = q('a', 1)[0];
  const muted = q('small, .muted, [class*=muted], [class*=subtle], [class*=secondary], figcaption', 1)[0];
  const bordered = q('input, textarea, select, [class*=card], [class*=panel], hr', 10)
    .map((el) => { const s = cs(el); return parseFloat(s.borderTopWidth) > 0 ? s.borderTopColor : (el.tagName === 'HR' ? s.borderTopColor : null); })
    .filter(Boolean);
  const radii = q('button, input, [class*=card], [class*=btn], [class*=panel]', 16).map((el) => parseFloat(cs(el).borderTopLeftRadius) || 0);
  const shadowEl = q('[class*=card], [class*=panel], [class*=modal], [class*=popover]', 8).find((el) => cs(el).boxShadow && cs(el).boxShadow !== 'none');
  return {
    bg, fg: cs(body).color, bodyFont: cs(body).fontFamily,
    headingFont: h ? cs(h).fontFamily : null, monoFont: code ? cs(code).fontFamily : null,
    buttons, link: link ? cs(link).color : null, muted: muted ? cs(muted).color : null,
    borders: bordered, radii, shadow: shadowEl ? cs(shadowEl).boxShadow : null,
  };
})()`;

const white: RGBA = { r: 255, g: 255, b: 255, a: 1 };

export function tokensFromSamples(raw: Raw): PartialTokens {
  const sources: Record<string, string> = {};
  const colors: Record<string, string> = {};
  const bgC = parseColor(raw.bg) ?? white;
  const background = toHex(bgC.a < 1 ? mix(bgC, white, bgC.a) : bgC);
  colors.background = background; sources['colors.background'] = 'runtime: page background';
  const fg = normalizeColor(raw.fg, bgC);
  if (fg) { colors.foreground = fg; sources['colors.foreground'] = 'runtime: body text'; }
  const bgRGBA = parseColor(background)!;

  // The accent is the first vivid, filled button that differs from the page; a link colour if none does.
  const accent = raw.buttons.map((b) => ({ c: parseColor(b.bg), sel: b.sel })).find((b) => b.c && b.c.a > 0.5 && distance(b.c, bgRGBA) > 60 && saturation(b.c) > 0.18);
  if (accent?.c) { colors.accent = toHex(accent.c); sources['colors.accent'] = `runtime: ${accent.sel} background`; }
  else {
    const filled = raw.buttons.map((b) => ({ c: parseColor(b.bg), sel: b.sel })).find((b) => b.c && b.c.a > 0.5 && distance(b.c, bgRGBA) > 60);
    const link = normalizeColor(raw.link, bgRGBA);
    if (filled?.c) { colors.accent = toHex(filled.c); sources['colors.accent'] = `runtime: ${filled.sel} background`; }
    else if (link && link !== fg) { colors.accent = link; sources['colors.accent'] = 'runtime: link colour'; }
  }
  const muted = normalizeColor(raw.muted, bgRGBA);
  if (muted && muted !== fg) { colors.muted = muted; sources['colors.muted'] = 'runtime: secondary text'; }
  const border = raw.borders.map((b) => normalizeColor(b, bgRGBA)).find((b) => b && b !== background);
  if (border) { colors.border = border; sources['colors.border'] = 'runtime: input/card border'; }

  const fonts: Record<string, string> = {};
  const body = fontStack(raw.bodyFont);
  if (body) { fonts.body = body; sources['fonts.body'] = 'runtime: body font'; }
  const heading = raw.headingFont ? fontStack(raw.headingFont) : null;
  if (heading && heading !== body) { fonts.display = heading; sources['fonts.display'] = 'runtime: heading font'; }
  const mono = raw.monoFont ? fontStack(raw.monoFont) : null;
  if (mono && /mono|code|courier|consolas/i.test(mono)) { fonts.mono = mono; sources['fonts.mono'] = 'runtime: code font'; }

  const out: PartialTokens = { colors, fonts, sources };
  const r = raw.radii.filter((n) => n >= 0 && n < 100).sort((a, b) => a - b);
  if (r.length) { out.radius = Math.round(r[Math.floor(r.length / 2)]!); sources.radius = 'runtime: buttons, inputs and cards'; }
  if (raw.shadow) {
    const m = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(raw.shadow);
    out.shadow = m && parseFloat(m[3]!) === 0 && (parseFloat(m[1]!) !== 0 || parseFloat(m[2]!) !== 0) ? 'hard' : 'soft';
    sources.shadow = 'runtime: card shadow';
  } else if (raw.radii.length) { out.shadow = 'none'; sources.shadow = 'runtime: no card shadow'; }
  return out;
}

export async function sampleRuntime(page: EvalPage): Promise<PartialTokens> {
  return tokensFromSamples(await page.evaluate<Raw>(SAMPLE_SCRIPT));
}
