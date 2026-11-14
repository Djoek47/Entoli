import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { integrations, sandboxes, testRuns } from '@/db/schema';
import { createApp, getApp, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { bootSandbox, detectStack, queueSandbox, runChecks, stopSandbox } from '@/lib/sandbox-boot';
import { localProvider } from '@/lib/sandbox';

let db: DB;
const cleanups: string[] = [];
beforeAll(async () => {
  db = await memoryDb();
  if (!process.env.ENTOLI_CHROMIUM_PATH && existsSync('/opt/pw-browsers/chromium')) process.env.ENTOLI_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
});
afterAll(async () => { for (const d of cleanups) await rm(d, { recursive: true, force: true }); });

const sdkBundle = readFileSync(fileURLToPath(new URL('../../../packages/sdk/dist/entoli.min.js', import.meta.url)), 'utf8');

const skill = {
  entoli: '0.1', app: { name: 'Plain notes' }, layer: 'L1', mode: 'text',
  map: [{ id: 'home', kind: 'screen', title: 'Notes', path: '/' }, { id: 'home.bar', kind: 'form', title: 'Entoli bar', parent: 'home', selector: '#bar' }, { id: 'home.list', kind: 'menu', title: 'List', parent: 'home', selector: '#list' }],
  knowledge: [],
  acts: [
    { name: 'note.create', title: 'New note', phrases: ['new note'], radius: 'self', undo: true, screen: 'home', slots: { text: { type: 'freeText', required: true } } },
    { name: 'note.clear', title: 'Clear notes', phrases: ['clear notes'], radius: 'self', undo: true, screen: 'home' },
    { name: 'note.ghost', title: 'Ghost note', phrases: ['ghost note'], radius: 'self', undo: true, screen: 'home' },
  ],
};

const SERVER = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
createServer(async (req, res) => {
  const p = req.url.split('?')[0]; const f = p === '/' ? 'index.html' : p.slice(1);
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': types[f.slice(f.lastIndexOf('.'))] ?? 'text/plain' }); res.end(b); }
  catch { res.writeHead(404).end('nope'); }
}).listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1');
`;
const PLAIN_HTML = '<!doctype html><title>Plain notes</title><div id="bar"></div><ul id="list"></ul>';
const WIRED_HTML = '<!doctype html><title>Plain notes</title><div id="bar"></div><ul id="list"></ul><script src="/entoli.min.js"></script><script src="/main.js"></script>';
const MAIN_JS = `(async () => {
  const skill = await (await fetch('/entoli.skill.json')).json();
  const list = document.getElementById('list');
  Entoli.defineAct('note.create', { text: 'freeText' }, ({ text }) => { const li = document.createElement('li'); li.textContent = text; list.append(li); return li; }, { undo: (li) => li.remove() });
  Entoli.defineAct('note.clear', {}, () => { const html = list.innerHTML; list.innerHTML = ''; return html; }, { undo: (html) => { list.innerHTML = html; } });
  Entoli.mount({ el: document.getElementById('bar'), skill, fonts: false });
})();`;

async function repoDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'entoli-repo-fixture-'));
  cleanups.push(dir);
  for (const [p, c] of Object.entries(files)) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), c); }
  return { dir, bytes: 1, cleanup: async () => {} };
}

async function setup() {
  const u = await upsertUser(db, { githubId: `sb${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Plain notes', repo: 'acme/plain-notes' });
  await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
  expect((await saveSkill(db, u.id, app.id, skill, 'draft')).ok).toBe(true);
  return { user: u, app: (await getApp(db, u.id, app.id))! };
}

describe('detectStack', () => {
  const f = (o: Record<string, string>) => Object.entries(o).map(([path, content]) => ({ path, content }));
  it('picks the package manager and the right dev command for the framework', () => {
    expect(detectStack(f({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }) }), 3000)).toMatchObject({ framework: 'vite', install: ['npm', ['install', '--no-audit', '--no-fund']], dev: ['npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '3000']] });
    expect(detectStack(f({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '16' } }), 'pnpm-lock.yaml': '' }), 3000)).toMatchObject({ framework: 'next', install: ['npx', ['--yes', 'pnpm', 'install', '--no-frozen-lockfile']], dev: ['npm', ['run', 'dev', '--', '-H', '0.0.0.0', '-p', '3000']] });
    expect(detectStack(f({ 'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }), 'yarn.lock': '' }), 3000).install![0]).toBe('npx');
  });
  it('says plainly why it cannot', () => {
    expect(() => detectStack(f({ 'README.md': 'x' }), 3000)).toThrow(/no package.json/);
    expect(() => detectStack(f({ 'package.json': '{}' }), 3000)).toThrow(/no "dev" or "start" script/);
    expect(() => detectStack(f({ 'package.json': '{nope' }), 3000)).toThrow(/not valid JSON/);
  });
});

describe('the sandbox, end to end (local provider)', () => {
  it('boots the app with the integration overlaid (approved and pending, not rejected), then checks it in a real browser', async () => {
    const { user, app } = await setup();
    await db.insert(integrations).values({
      appId: app.id, status: 'generated', answers: { agent: true },
      changes: [
        { id: 'a', title: 'skill', file: 'entoli.skill.json', content: JSON.stringify(skill), diff: '', status: 'approved' },
        { id: 'b', title: 'sdk', file: 'entoli.min.js', content: sdkBundle, diff: '', status: 'approved' },
        { id: 'c', title: 'wire', file: 'main.js', content: MAIN_JS, diff: '', status: 'pending' },
        { id: 'd', title: 'page', file: 'index.html', content: WIRED_HTML, diff: '', status: 'pending' },
        { id: 'e', title: 'bad idea', file: 'evil.js', content: 'throw new Error("x")', diff: '', status: 'rejected' },
      ],
    });
    const q = await queueSandbox(db, app);
    if ('error' in q) throw new Error(q.error);
    expect(await queueSandbox(db, app)).toEqual({ error: 'A sandbox is already starting for this app.' });

    const provider = localProvider();
    await bootSandbox(db, app, q.id, { provider, source: async () => repoDir({ 'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'node server.mjs' } }), 'server.mjs': SERVER, 'index.html': PLAIN_HTML }) });
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
    expect(row!.log.join('\n')).toMatch(/Applied 4 changes \(2 still waiting for your approval\)/);
    expect(row!.status, row!.error ?? '').toBe('ready');
    expect(row!.applied).toEqual([{ file: 'entoli.skill.json', status: 'approved' }, { file: 'entoli.min.js', status: 'approved' }, { file: 'main.js', status: 'pending' }, { file: 'index.html', status: 'pending' }]);

    // The window really serves the app with the Entoli layer, and not the rejected change.
    const page = await (await fetch(row!.url!)).text();
    expect(page).toContain('/entoli.min.js');
    expect((await fetch(`${row!.url}/evil.js`)).status).toBe(404);

    const checks = await runChecks(db, app, q.id);
    expect(checks.hasBar).toBe(true);
    expect(checks.walk).toMatchObject({ coverage: 100, broken: [] });
    const by = Object.fromEntries(checks.phrases.map((p) => [p.act, p]));
    expect(by['note.create']).toMatchObject({ status: 'ok' });            // asks for the missing text: understood
    expect(by['note.clear']).toMatchObject({ status: 'ran' });            // held, ran, undone
    expect(by['note.ghost']).toMatchObject({ status: 'not-understood' }); // declared in the skill, never wired in the app
    expect(checks.summary).toMatchObject({ checked: 3, good: 2, percent: 67 });
    const [stored] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
    expect((stored!.results as { summary: { percent: number } }).summary.percent).toBe(67);
    expect((await db.select().from(testRuns).where(eq(testRuns.appId, app.id)))[0]).toMatchObject({ coverage: 100 });

    await stopSandbox(db, app, q.id);
    expect((await db.select().from(sandboxes).where(eq(sandboxes.id, q.id)))[0]!.status).toBe('stopped');
    await expect(fetch(row!.url!, { signal: AbortSignal.timeout(1500) })).rejects.toBeDefined();
  }, 240_000);

  it('with no Entoli changes it still runs the app, and says the bar is missing instead of failing', async () => {
    const { app } = await setup();
    const q = await queueSandbox(db, app);
    if ('error' in q) throw new Error(q.error);
    await bootSandbox(db, app, q.id, { provider: localProvider(), source: async () => repoDir({ 'package.json': JSON.stringify({ scripts: { dev: 'node server.mjs' } }), 'server.mjs': SERVER, 'index.html': PLAIN_HTML }) });
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
    expect(row!.log.join('\n')).toMatch(/No Entoli changes yet/);
    const checks = await runChecks(db, app, q.id);
    expect(checks.hasBar).toBe(false);
    expect(checks.phrases.every((p) => p.status === 'skipped')).toBe(true);
    await stopSandbox(db, app, q.id);
  }, 240_000);

  it('records a clear failure, and cleans up', async () => {
    const { app } = await setup();
    const q = await queueSandbox(db, app);
    if ('error' in q) throw new Error(q.error);
    await bootSandbox(db, app, q.id, { provider: localProvider(), source: async () => repoDir({ 'README.md': 'no package.json here' }) });
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.error).toMatch(/no package.json/);
  });
});

describe('access and safety', () => {
  it('is L2 only and needs a repository', async () => {
    const { app } = await setup();
    await setPlan(db, app.id, 'l1', { id: 's', status: 'active' });
    expect(await queueSandbox(db, (await getApp(db, app.ownerId, app.id))!)).toEqual({ error: 'The test sandbox is part of the L2 plan.' });
    const u = await upsertUser(db, { githubId: `sb${Math.random()}`, login: 'x' });
    const { app: bare } = await createApp(db, u.id, { name: 'bare' });
    await setPlan(db, bare.id, 'l2', { id: 's', status: 'active' });
    expect(await queueSandbox(db, (await getApp(db, u.id, bare.id))!)).toEqual({ error: 'Connect a repository first.' });
  });

  it('refuses to run developers\' code on our own machine in production', () => {
    const keep = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    try { expect(() => localProvider()).toThrow(/disabled in production/); } finally { (process.env as Record<string, string>).NODE_ENV = keep!; }
  });

  it('refuses paths that would escape the sandbox', async () => {
    const sb = await localProvider().create({ timeoutMs: 1000, port: 1 });
    await expect(sb.writeFiles([{ path: '../escape.txt', content: 'x' }])).rejects.toThrow(/unsafe path/);
    await sb.stop();
  });
});
