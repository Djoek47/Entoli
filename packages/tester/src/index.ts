/**
 * Walk an app's map in a real browser.
 *
 *   screens   each screen with a concrete path is opened; it must answer
 *             below 400 and throw no uncaught error while loading
 *   nodes     each node with a selector must be found on its screen
 *             (shared nodes on the first screen)
 *
 * Coverage = verified / checkable. Screens with route parameters (/notes/:id)
 * and nodes with no selector cannot be checked blind; they are listed, not
 * counted as broken.
 */
import { createRequire } from 'node:module';
import type { MapNode, Skill } from '@entoli/sdk/skill';

/** The few Playwright calls the walk uses (so Playwright stays an optional peer). */
export type PageLike = {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<{ status(): number } | null>;
  locator(selector: string): { first(): { waitFor(opts: { state: 'attached' | 'visible'; timeout: number }): Promise<void> } };
  on(event: 'pageerror', fn: (e: Error) => void): unknown;
  close(): Promise<void>;
};
export type BrowserLike = { newPage(): Promise<PageLike>; close(): Promise<void> };

export type NodeResult = { id: string; title: string; kind: string; screen?: string; status: 'ok' | 'broken' | 'unchecked'; reason?: string };
export type Report = {
  url: string;
  coverage: number;
  checked: number;
  verified: number;
  broken: NodeResult[];
  unchecked: NodeResult[];
  nodes: NodeResult[];
  startedAt: string;
  ms: number;
};

export type WalkOptions = { timeoutMs?: number; selectorTimeoutMs?: number; log?: (line: string) => void };

function screenOf(node: MapNode, byId: Map<string, MapNode>): MapNode | null {
  for (let n: MapNode | undefined = node; n; n = n.parent ? byId.get(n.parent) : undefined) if (n.kind === 'screen' && n !== node) return n;
  return null;
}

export async function walkMap(skill: Skill, baseUrl: string, browser: BrowserLike, opts: WalkOptions = {}): Promise<Report> {
  const started = Date.now();
  const base = baseUrl.replace(/\/$/, '');
  const byId = new Map(skill.map.map((n) => [n.id, n]));
  const screens = skill.map.filter((n) => n.kind === 'screen');
  const concrete = screens.filter((s) => s.path !== undefined && !s.path.includes(':') && !s.path.includes('*'));
  const fallback = concrete.find((s) => s.path === '/') ?? concrete[0] ?? null;
  const results = new Map<string, NodeResult>();
  const say = opts.log ?? (() => {});

  // Which screen each non-screen node is checked on.
  const nodesOn = new Map<string, MapNode[]>();
  for (const n of skill.map) {
    if (n.kind === 'screen') continue;
    const sc = screenOf(n, byId) ?? fallback;
    const r: NodeResult = { id: n.id, title: n.title, kind: n.kind, ...(sc ? { screen: sc.id } : {}), status: 'unchecked' };
    if (!n.selector) { r.reason = 'no selector'; results.set(n.id, r); continue; }
    if (!sc || !concrete.includes(sc)) { r.reason = sc ? `its screen ${sc.path} has route parameters` : 'no screen to open'; results.set(n.id, r); continue; }
    results.set(n.id, r);
    (nodesOn.get(sc.id) ?? nodesOn.set(sc.id, []).get(sc.id)!).push(n);
  }
  for (const s of screens) {
    if (!concrete.includes(s)) results.set(s.id, { id: s.id, title: s.title, kind: 'screen', status: 'unchecked', reason: s.path ? 'route parameters' : 'no path' });
  }

  for (const s of concrete) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const sr: NodeResult = { id: s.id, title: s.title, kind: 'screen', screen: s.id, status: 'ok' };
    try {
      const res = await page.goto(`${base}${s.path}`, { waitUntil: 'load', timeout: opts.timeoutMs ?? 15_000 });
      const status = res?.status() ?? 0;
      if (status >= 400) { sr.status = 'broken'; sr.reason = `HTTP ${status}`; }
    } catch (e) {
      sr.status = 'broken';
      sr.reason = (e as Error).message.split('\n')[0];
    }
    if (sr.status === 'ok' && errors.length) { sr.status = 'broken'; sr.reason = `page error: ${errors[0]}`; }
    results.set(s.id, sr);
    say(`${sr.status === 'ok' ? '✓' : '✗'} ${s.path} ${sr.reason ?? ''}`);

    for (const n of nodesOn.get(s.id) ?? []) {
      const r = results.get(n.id)!;
      if (sr.status !== 'ok') { r.status = 'broken'; r.reason = `screen ${s.path} did not load`; continue; }
      try {
        await page.locator(n.selector!).first().waitFor({ state: 'attached', timeout: opts.selectorTimeoutMs ?? 2_000 });
        r.status = 'ok';
      } catch {
        r.status = 'broken';
        r.reason = `not found on ${s.path}: ${n.selector}`;
      }
      say(`  ${r.status === 'ok' ? '✓' : '✗'} ${n.title}${r.reason ? ` (${r.reason})` : ''}`);
    }
    await page.close();
  }

  const nodes = skill.map.map((n) => results.get(n.id)!).filter(Boolean);
  const checked = nodes.filter((n) => n.status !== 'unchecked');
  const verified = checked.filter((n) => n.status === 'ok');
  return {
    url: base,
    coverage: checked.length ? Math.round((verified.length / checked.length) * 100) : 0,
    checked: checked.length,
    verified: verified.length,
    broken: nodes.filter((n) => n.status === 'broken'),
    unchecked: nodes.filter((n) => n.status === 'unchecked'),
    nodes,
    startedAt: new Date(started).toISOString(),
    ms: Date.now() - started,
  };
}

/** A local Chromium (ENTOLI_CHROMIUM_PATH to pick a build), or a remote one (BROWSER_WS_ENDPOINT, e.g. a hosted browser service). */
export async function openBrowser(wsEndpoint = process.env.BROWSER_WS_ENDPOINT): Promise<BrowserLike> {
  const require = createRequire(import.meta.url);
  let pw: { chromium: { launch(o?: object): Promise<BrowserLike>; connect(ws: string): Promise<BrowserLike> } };
  try { pw = require('playwright') as typeof pw; } catch { throw new Error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium'); }
  if (wsEndpoint) return pw.chromium.connect(wsEndpoint);
  // A specific Chromium build (CI images that ship their own): ENTOLI_CHROMIUM_PATH.
  const executablePath = process.env.ENTOLI_CHROMIUM_PATH;
  return pw.chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : {});
}

export async function testApp(skill: Skill, url: string, opts: WalkOptions & { browser?: BrowserLike } = {}): Promise<Report> {
  const browser = opts.browser ?? (await openBrowser());
  try { return await walkMap(skill, url, browser, opts); }
  finally { if (!opts.browser) await browser.close(); }
}
