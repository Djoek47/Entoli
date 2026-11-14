/** Colour maths: parsing the many ways CSS writes a colour, and contrast. */

export type RGBA = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000', transparent: '#00000000', red: '#ff0000', blue: '#0000ff', green: '#008000', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', yellow: '#ffff00', pink: '#ffc0cb', teal: '#008080', navy: '#000080' };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const num = (s: string) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));

/** Accepts #rgb #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), shadcn-style "h s% l%" triples, and a few names. */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  let v = input.trim().toLowerCase().replace(/\s*!important$/, '');
  if (NAMED[v]) v = NAMED[v]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const ch = (s: string) => clamp(Math.round(s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s)), 0, 255);
    return { r: ch(m[1]!), g: ch(m[2]!), b: ch(m[3]!), a: m[4] ? clamp(num(m[4]), 0, 1) : 1 };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+%)[\s,]+([\d.]+%)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) { const [r, g, b] = hslToRgb(parseFloat(m[1]!), num(m[2]!), num(m[3]!)); return { r, g, b, a: m[4] ? clamp(num(m[4]), 0, 1) : 1 }; }
  m = /^([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?$/.exec(v);
  if (m) { const [r, g, b] = hslToRgb(parseFloat(m[1]!), parseFloat(m[2]!) / 100, parseFloat(m[3]!) / 100); return { r, g, b, a: m[4] ? clamp(num(m[4]), 0, 1) : 1 }; }
  return null;
}

const h2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
export const toHex = (c: RGBA): string => `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;

/** A colour string as #rrggbb, composited on `over` when it has transparency. */
export function normalizeColor(input: string | null | undefined, over: RGBA = { r: 255, g: 255, b: 255, a: 1 }): string | null {
  const c = parseColor(input);
  if (!c || c.a === 0) return null;
  return toHex(c.a < 1 ? mix(c, over, c.a) : c);
}

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: a.r * t + b.r * (1 - t), g: a.g * t + b.g * (1 - t), b: a.b * t + b.b * (1 - t), a: 1 };
}

export function luminance(c: RGBA): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: RGBA, b: RGBA): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export function saturation(c: RGBA): number {
  const max = Math.max(c.r, c.g, c.b) / 255, min = Math.min(c.r, c.g, c.b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

export function distance(a: RGBA, b: RGBA): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Move `fg` toward black or white until it reads on `bg` (default WCAG AA for text, 4.5). Keeps the hue where it can. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  const f = parseColor(fg), b = parseColor(bg);
  if (!f || !b) return fg;
  if (contrast(f, b) >= min) return toHex(f);
  const target: RGBA = luminance(b) > 0.4 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(target, f, t);
    if (contrast(c, b) >= min) return toHex(c);
  }
  return toHex(target);
}

/** Black or white, whichever reads better on `bg` (for text placed on the accent). */
export function onColor(bg: string): string {
  const b = parseColor(bg);
  if (!b) return '#0e0f0c';
  return contrast(b, { r: 14, g: 15, b: 12, a: 1 }) >= contrast(b, { r: 255, g: 255, b: 255, a: 1 }) ? '#0e0f0c' : '#ffffff';
}

/** Shift lightness: positive lightens, negative darkens (amount 0..1). */
export function shift(hex: string, amount: number): string {
  const c = parseColor(hex);
  if (!c) return hex;
  return toHex(mix(amount >= 0 ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }, c, Math.abs(amount)));
}

/** #rrggbb, or #rrggbbaa when translucent (kept so it can be blended over the right background later). null when fully transparent or unparseable. */
export function normalizeColorAlpha(input: string | null | undefined): string | null {
  const c = parseColor(input);
  if (!c || c.a === 0) return null;
  return c.a < 1 ? `${toHex(c)}${h2(c.a * 255)}` : toHex(c);
}

/** Blend a possibly translucent #rrggbb[aa] over an opaque background. */
export function over(color: string, background: string): string {
  const c = parseColor(color), b = parseColor(background);
  if (!c || !b) return color;
  return toHex(c.a < 1 ? mix(c, b, c.a) : c);
}
