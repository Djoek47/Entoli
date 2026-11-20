/**
 * Boot a developer's app in a sandbox with the Entoli layer applied, so they
 * can try it before approving anything.
 *
 *   1. download the repository (every file, read-only)
 *   2. overlay the integration's changes that are not rejected: the approved
 *      ones AND the pending ones. The sandbox is where a change is judged,
 *      so it must show changes that are still waiting for a yes
 *   3. install, start the dev server, wait for it to answer
 *   4. checks: the map walk, and every act's phrase typed into the real bar
 *
 * The sandbox is disposable and holds no secrets: no environment from the
 * developer's project is copied in. Apps that need a database or an API key
 * run only as far as they can without one; the log says where it stopped.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { skillOf } from './apps';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '@/db';
import { apps, integrations, sandboxes, testRuns } from '@/db/schema';
import { fetchRepo, type Fetched } from './repo-fetch';
import { freePort, sandboxProvider, SANDBOX_TIMEOUT_MS, type Sandbox, type SandboxFile, type SandboxProvider } from './sandbox';
import { hit } from './ratelimit';
import { appRoot, projectFilesOf } from './project';
import { PLANS } from './plans';

type AppRow = typeof apps.$inferSelect;

const live = ((globalThis as unknown as { __entoliSandboxes?: Map<string, Sandbox> }).__entoliSandboxes ??= new Map());
const MAX_FILES = 4000;
const MAX_TOTAL = 40 * 1024 * 1024;

export type BootDeps = {
  /** Which side: the new project (default) or the original it was copied from. */
  role?: 'new' | 'original';
  provider?: SandboxProvider;
  /** The repository to run. Default: GitHub, every file. */
  source?: (app: AppRow) => Promise<Fetched>;
  port?: number;
};

export async function queueSandbox(db: DB, app: AppRow, role: 'new' | 'original' = 'new'): Promise<{ id: string } | { error: string }> {
  if (!PLANS[app.plan].integration) return { error: 'The test sandbox is part of the L2 plan.' };
  const project = app.origin?.kind === 'blank' || app.origin?.kind === 'rebuild';
  if (role === 'original' && app.origin?.kind !== 'rebuild') return { error: 'Only a rebuild has an original to run.' };
  if (!app.repo && !project) return { error: 'Connect a repository first.' };
  if (!(await hit(db, `sandbox:${app.ownerId}`, 6, 3_600_000)).ok) return { error: 'Six sandboxes an hour at most. Try again later.' };
  const [busy] = await db.select({ id: sandboxes.id }).from(sandboxes).where(and(eq(sandboxes.appId, app.id), eq(sandboxes.status, 'booting'), eq(sandboxes.role, role)));
  if (busy) return { error: 'A sandbox is already starting for this app.' };
  const [row] = await db.insert(sandboxes).values({ appId: app.id, role, provider: process.env.SANDBOX_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'vercel' : 'local'), status: 'booting', log: [] }).returning({ id: sandboxes.id });
  return { id: row!.id };
}

async function walk(root: string): Promise<SandboxFile[]> {
  const out: SandboxFile[] = [];
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await stat(p);
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!st.isFile()) continue;
      total += st.size;
      if (out.length >= MAX_FILES || total > MAX_TOTAL) throw new Error(`The repository is too large to run in a test sandbox (over ${MAX_FILES} files or ${MAX_TOTAL / 1e6} MB).`);
      out.push({ path: relative(root, p).split(sep).join('/'), content: await readFile(p) });
    }
  }
  return out;
}

export type Stack = { install: [string, string[]] | null; dev: [string, string[]]; framework: string };

/** How to install and start this app, from its package.json and lockfile. */
export function detectStack(files: SandboxFile[], port: number): Stack {
  const text = (p: string) => { const f = files.find((x) => x.path === p); return f ? Buffer.from(f.content).toString('utf8') : null; };
  const pkgText = text('package.json');
  if (!pkgText) throw new Error('This app has no package.json at its root, so Entoli cannot start it in a sandbox. In a monorepo, connect the folder of the app, like owner/name#apps/web.');
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(pkgText); } catch { throw new Error('package.json is not valid JSON.'); }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // Packages that live elsewhere in the same monorepo cannot be installed from a registry.
  const local = Object.entries(deps).filter(([, v]) => /^(workspace:|link:|file:\.\.|portal:)/.test(String(v))).map(([k]) => k);
  if (local.length) throw new Error(`This app depends on packages inside its own monorepo (${local.slice(0, 4).join(', ')}${local.length > 4 ? ', …' : ''}), which a sandbox cannot install from a registry. Run it from the monorepo's own tooling, or point Entoli at an app that installs on its own.`);
  const has = (p: string) => files.some((f) => f.path === p);
  const install: Stack['install'] = has('pnpm-lock.yaml') ? ['npx', ['--yes', 'pnpm', 'install', '--no-frozen-lockfile']]
    : has('yarn.lock') ? ['npx', ['--yes', 'yarn', 'install']]
    : ['npm', ['install', '--no-audit', '--no-fund']];
  const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null;
  if (!script) throw new Error('package.json has no "dev" or "start" script to run.');
  const framework = deps.next ? 'next' : deps.vite ? 'vite' : 'node';
  const extra = framework === 'vite' ? ['--', '--host', '0.0.0.0', '--port', String(port)] : framework === 'next' ? ['--', '-H', '0.0.0.0', '-p', String(port)] : [];
  return { install, dev: ['npm', ['run', script, ...extra]], framework };
}

export type Applied = { file: string; status: 'approved' | 'pending' };

export async function bootSandbox(db: DB, app: AppRow, sandboxId: string, deps: BootDeps = {}): Promise<void> {
  const log: string[] = [];
  const flush = (patch: Partial<typeof sandboxes.$inferInsert> = {}) => db.update(sandboxes).set({ log: [...log], ...patch }).where(eq(sandboxes.id, sandboxId));
  const say = async (l: string) => { log.push(l); await flush(); };
  let fetched: Fetched | null = null;
  let sbx: Sandbox | null = null;
  try {
    const provider = deps.provider ?? sandboxProvider();
    const port = deps.port ?? (provider.name === 'local' ? await freePort() : 3000);
    const role = deps.role ?? 'new';
    const project = (app.origin?.kind === 'blank' || app.origin?.kind === 'rebuild') && role === 'new';
    let files: SandboxFile[];
    if (project) {
      files = (await projectFilesOf(db, app.id)).map((f) => ({ path: f.path, content: f.content }));
      if (!files.length) throw new Error('This project has no files yet.');
      await say(`${files.length} project files.`);
    } else {
      await say(`Downloading ${app.repo}${role === 'original' ? ' (the original, untouched)' : ''}…`);
      fetched = await (deps.source ?? ((a) => fetchRepo(a.repo!, { installationId: a.installationId, all: true })))(app);
      files = await walk(await appRoot(fetched.dir, app.subdir));
      await say(`${files.length} files.`);
    }

    // Overlay the integration (approved and pending), so the changes can be tried before they are approved.
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(1);
    const applied: Applied[] = [];
    if (row && row.status !== 'pr_opened' && (project || role === 'new')) {
      for (const c of row.changes.filter((c) => c.status !== 'rejected')) {
        const i = files.findIndex((f) => f.path === c.file);
        if (i >= 0) files[i] = { path: c.file, content: c.content }; else files.push({ path: c.file, content: c.content });
        applied.push({ file: c.file, status: c.status === 'approved' ? 'approved' : 'pending' });
      }
    }
    await say(applied.length ? `Applied ${applied.length} change${applied.length > 1 ? 's' : ''} (${applied.filter((a) => a.status === 'pending').length} still waiting for your approval).` : 'No Entoli changes yet: this is your app as it is.');

    const stack = detectStack(files, port);
    await say(`Starting an isolated ${provider.name === 'vercel' ? 'Vercel Sandbox' : 'local sandbox'} (${stack.framework}).`);
    sbx = await provider.create({ timeoutMs: SANDBOX_TIMEOUT_MS, port });
    live.set(sandboxId, sbx);
    for (let i = 0; i < files.length; i += 100) await sbx.writeFiles(files.slice(i, i + 100));

    if (stack.install) {
      await say(`Installing dependencies (${stack.install[0]} ${stack.install[1].join(' ')})…`);
      const r = await sbx.run(stack.install[0], stack.install[1], { timeoutMs: 300_000 });
      if (r.code !== 0) throw new Error(`Installing dependencies failed (exit ${r.code}).\n${r.output.slice(-1200)}`);
    }
    await say(`Starting the app (${stack.dev[0]} ${stack.dev[1].join(' ')})…`);
    const served = await sbx.serve(stack.dev[0], stack.dev[1], port, {
      // Vite refuses unknown Host headers; the sandbox's own domain must be allowed.
      env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.vercel.run,.vercel.app,localhost,127.0.0.1', BROWSER: 'none' },
    });
    await say(`Ready at ${served.url}`);
    await flush({ status: 'ready', url: served.url, remoteId: sbx.id, applied, expiresAt: new Date(Date.now() + SANDBOX_TIMEOUT_MS) });
  } catch (e) {
    log.push(`Failed: ${(e as Error).message}`);
    await flush({ status: 'failed', error: (e as Error).message.slice(0, 2000) });
    if (sbx) { await sbx.stop().catch(() => {}); live.delete(sandboxId); }
  } finally {
    await fetched?.cleanup().catch(() => {});
  }
}

export async function stopSandbox(db: DB, app: AppRow, sandboxId: string, provider?: SandboxProvider): Promise<void> {
  const [row] = await db.select().from(sandboxes).where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.appId, app.id)));
  if (!row) return;
  const mem = live.get(sandboxId);
  try {
    if (mem) await mem.stop();
    else if (row.remoteId) await (provider ?? sandboxProvider()).stopById(row.remoteId);
  } catch (e) { console.error('[sandbox] stop failed', e); }
  live.delete(sandboxId);
  await db.update(sandboxes).set({ status: 'stopped' }).where(eq(sandboxes.id, sandboxId));
}

/** Stop whatever is still running for this app (one live sandbox per app). */
export async function stopOthers(db: DB, app: AppRow, keep: string, provider?: SandboxProvider, role: 'new' | 'original' = 'new') {
  const rows = await db.select({ id: sandboxes.id }).from(sandboxes).where(and(eq(sandboxes.appId, app.id), eq(sandboxes.role, role), inArray(sandboxes.status, ['ready'])));
  for (const r of rows) if (r.id !== keep) await stopSandbox(db, app, r.id, provider);
}

export type Checks = {
  at: string;
  walk: { coverage: number; checked: number; verified: number; broken: { title: string; reason?: string }[]; unchecked: number } | null;
  phrases: { act: string; title: string; phrase: string; status: string; reason?: string; got?: string }[];
  summary: { checked: number; good: number; percent: number; skipped: number };
  hasBar: boolean;
};

/** Open the running sandbox in a real browser: walk the map, then type each act's phrase into the bar. */
export async function runChecks(db: DB, app: AppRow, sandboxId: string, deps: { browser?: import('@entoli/tester').BrowserLike } = {}): Promise<Checks> {
  const [row] = await db.select().from(sandboxes).where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.appId, app.id)));
  if (!row || row.status !== 'ready' || !row.url) throw new Error('The sandbox is not running.');
  const skill = skillOf(app);
  if (!skill) throw new Error('No valid skill yet.');
  if (process.env.NODE_ENV === 'production' && !process.env.BROWSER_WS_ENDPOINT && !deps.browser) throw new Error('No browser on this deployment. Set BROWSER_WS_ENDPOINT.');
  const { openBrowser, walkMap, checkPhrases, summarizePhrases } = await import('@entoli/tester');
  const browser = deps.browser ?? (await openBrowser());
  try {
    const [walk, phrases] = [await walkMap(skill, row.url, browser), await checkPhrases(skill, row.url, browser)];
    const summary = summarizePhrases(phrases);
    const checks: Checks = {
      at: new Date().toISOString(),
      walk: { coverage: walk.coverage, checked: walk.checked, verified: walk.verified, broken: walk.broken.map((b) => ({ title: b.title, ...(b.reason ? { reason: b.reason } : {}) })), unchecked: walk.unchecked.length },
      phrases: phrases.map((p) => ({ act: p.act, title: p.title, phrase: p.phrase, status: p.status, ...(p.reason ? { reason: p.reason } : {}), ...(p.got ? { got: p.got } : {}) })),
      summary: { checked: summary.checked, good: summary.good, percent: summary.percent, skipped: summary.skipped },
      hasBar: phrases.some((p) => p.status !== 'skipped'),
    };
    await db.update(sandboxes).set({ results: checks }).where(eq(sandboxes.id, sandboxId));
    await db.insert(testRuns).values({ appId: app.id, url: row.url, coverage: walk.coverage, report: { url: row.url, coverage: walk.coverage, checked: walk.checked, verified: walk.verified, broken: walk.broken, unchecked: walk.unchecked, ms: walk.ms, startedAt: walk.startedAt, source: 'sandbox' } });
    return checks;
  } finally {
    if (!deps.browser) await browser.close();
  }
}

export function latestSandbox(db: DB, appId: string, role: 'new' | 'original' = 'new') {
  return db.select().from(sandboxes).where(and(eq(sandboxes.appId, appId), eq(sandboxes.role, role))).orderBy(desc(sandboxes.createdAt)).limit(1);
}
