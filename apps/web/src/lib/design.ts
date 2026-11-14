/**
 * The app's design system, kept so Entoli's windows match it.
 *
 * Stored as what was FOUND (from the code, from the running app) plus the
 * tweaks the developer asked for, in order. The tokens are recomputed from
 * those, so re-extracting after the app changes keeps the tweaks on top.
 */
import { describeTokens, extractStatic, mergeTokens, sampleRuntime, themeCss, tweakTokens, type DesignTokens, type PartialTokens } from '@entoli/design';
import { eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { apps } from '@/db/schema';
import { fetchRepo, type Fetched } from './repo-fetch';
import { PLANS } from './plans';

type AppRow = typeof apps.$inferSelect;
export type Stored = { static: PartialTokens | null; runtime: PartialTokens | null; tweaks: string[]; extractedAt: string };

export function tokensOf(design: AppRow['design'] | Stored | null | undefined): DesignTokens | null {
  if (!design) return null;
  const d = design as Stored;
  let t = mergeTokens(d.static ?? undefined, d.runtime ?? undefined);
  for (const tw of d.tweaks) t = tweakTokens(t, tw).tokens;
  return t;
}

export const designAllowed = (app: AppRow) => PLANS[app.plan].integration;

async function save(db: DB, app: AppRow, d: Stored) {
  await db.update(apps).set({ design: d }).where(eq(apps.id, app.id));
  return tokensOf(d)!;
}

/** From the code: CSS variables, Tailwind and theme files, font imports. */
export async function extractFromRepo(db: DB, app: AppRow, deps: { source?: (a: AppRow) => Promise<Fetched> } = {}) {
  if (!designAllowed(app)) throw new Error('The design extractor is part of the L2 plan.');
  if (!app.repo) throw new Error('Connect a repository first.');
  const fetched = await (deps.source ?? ((a) => fetchRepo(a.repo!, { installationId: a.installationId, all: true })))(app);
  try {
    const { files, fontsImported: _f, ...found } = extractStatic(fetched.dir);
    void _f;
    const prev = app.design as Stored | null;
    const tokens = await save(db, app, { static: found, runtime: prev?.runtime ?? null, tweaks: prev?.tweaks ?? [], extractedAt: new Date().toISOString() });
    return { tokens, filesRead: files };
  } finally {
    await fetched.cleanup().catch(() => {});
  }
}

type Browser = { newPage(): Promise<unknown>; close(): Promise<void> };

/** From the running app (a sandbox or a preview URL): what people actually see. */
export async function sampleFromUrl(db: DB, app: AppRow, url: string, deps: { browser?: Browser } = {}) {
  if (!designAllowed(app)) throw new Error('The design extractor is part of the L2 plan.');
  if (process.env.NODE_ENV === 'production' && !process.env.BROWSER_WS_ENDPOINT && !deps.browser) throw new Error('No browser on this deployment. Set BROWSER_WS_ENDPOINT.');
  const { openBrowser } = await import('@entoli/tester');
  const browser = (deps.browser ?? (await openBrowser())) as Browser;
  try {
    const page = (await browser.newPage()) as { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(s: string): Promise<T>; close(): Promise<void> };
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
      const runtime = await sampleRuntime(page);
      const prev = app.design as Stored | null;
      return await save(db, app, { static: prev?.static ?? null, runtime, tweaks: prev?.tweaks ?? [], extractedAt: new Date().toISOString() });
    } finally { await page.close().catch(() => {}); }
  } finally {
    if (!deps.browser) await browser.close();
  }
}

export async function tweakDesign(db: DB, app: AppRow, instruction: string) {
  const d = app.design as Stored | null;
  if (!d) throw new Error('Extract the design first (from the code, or from the running sandbox).');
  const before = tokensOf(d)!;
  const r = tweakTokens(before, instruction.slice(0, 200));
  if (r.unknown) return { tokens: before, changes: [] as string[], understood: false };
  const tokens = await save(db, app, { ...d, tweaks: [...d.tweaks, instruction.slice(0, 200)] });
  return { tokens, changes: r.changes, understood: true };
}

export async function resetTweaks(db: DB, app: AppRow) {
  const d = app.design as Stored | null;
  if (!d) return null;
  return save(db, app, { ...d, tweaks: [] });
}

export { describeTokens, themeCss };
