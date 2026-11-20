import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { agentEvents, integrations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getApp, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { setChangeStatus } from '@/lib/integration';
import { createMcpToken, handleMcp } from '@/lib/mcp';
import { bootSandbox, queueSandbox, runChecks, stopSandbox } from '@/lib/sandbox-boot';
import { nameFromDescription, compare, exportZip, projectFilesOf, readProjectFile, startBlank, startRebuild, writeProjectFile } from '@/lib/project';
import { localProvider } from '@/lib/sandbox';

let db: DB;
const cleanups: string[] = [];
const provider = localProvider();
beforeAll(async () => {
  db = await memoryDb();
  if (!process.env.ENTOLI_CHROMIUM_PATH && existsSync('/opt/pw-browsers/chromium')) process.env.ENTOLI_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
});
afterAll(async () => { for (const d of cleanups) await rm(d, { recursive: true, force: true }); });

const bundle = readFileSync(fileURLToPath(new URL('../../../packages/sdk/dist/entoli.min.js', import.meta.url)), 'utf8');

const drafted = {
  entoli: '0.1', app: { name: 'x', description: 'A todo list' }, layer: 'L1', mode: 'text',
  map: [{ id: 'todos', kind: 'screen', title: 'Todos', path: '/', selector: '[data-screen=todos]' }, { id: 'done', kind: 'screen', title: 'Done', path: '/', selector: '[data-screen=done]' }],
  knowledge: [{ topic: 'sharing', can: false, answer: 'No. Todos stay private.', phrases: ['share list'] }],
  acts: [
    { name: 'todo.add', title: 'Add a todo', screen: 'todos', phrases: ['add todo', 'new todo'], radius: 'self', undo: true, slots: { text: { type: 'freeText', required: true } } },
    { name: 'todo.clear', title: 'Clear done todos', screen: 'done', phrases: ['clear done'], radius: 'self', undo: true },
  ],
};

async function user() { return upsertUser(db, { githubId: `pj${Math.random()}`, login: 'dev' }); }
const l2 = async (id: string) => setPlan(db, id, 'l2', { id: 's', status: 'active' });

describe('blank start', () => {
  it('writes the skill first, then a starter that runs in the sandbox and passes the map walk and every phrase', async () => {
    const u = await user();
    const r = await startBlank(db, u.id, { name: 'Todos', description: 'A todo list with a done screen' }, { drafter: async () => drafted });
    expect(r).toMatchObject({ drafted: true });
    await l2(r.appId);
    const app = (await getApp(db, u.id, r.appId))!;
    expect(app.origin).toMatchObject({ kind: 'blank' });
    expect((app.skill as { acts: unknown[] }).acts).toHaveLength(2);
    expect((app.skill as { app: { name: string } }).app.name).toBe('Todos');
    expect((await projectFilesOf(db, app.id)).map((f) => f.path)).toEqual(['app.css', 'app.js', 'entoli.min.js', 'entoli.skill.json', 'index.html', 'package.json', 'server.mjs']);

    const q = await queueSandbox(db, app);
    if ('error' in q) throw new Error(q.error);
    await bootSandbox(db, app, q.id, { provider });
    try {
      const checks = await runChecks(db, app, q.id);
      expect(checks.walk).toMatchObject({ coverage: 100, broken: [] });
      expect(checks.hasBar).toBe(true);
      expect(checks.summary.percent).toBe(100);
    } finally { await stopSandbox(db, app, q.id, provider); }
  }, 240_000);

  it('does not invent a skill without a model: it starts with one empty screen and says so', async () => {
    const u = await user();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await startBlank(db, u.id, { name: 'Empty', description: 'Something' });
      expect(r.drafted).toBe(false);
      expect(r.note).toMatch(/No model is configured/);
    } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
  });

  it('retries once when the draft is invalid, then falls back to empty', async () => {
    const u = await user();
    let calls = 0;
    const r = await startBlank(db, u.id, { name: 'Bad', description: 'Nope' }, { drafter: async () => { calls++; return { nonsense: true }; } });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ drafted: false });
    expect(r.note).toMatch(/not a valid skill/);
    await expect(startBlank(db, u.id, { name: 'X', description: '  ' })).rejects.toThrow(/Describe the app/);
  });

  it('exports the project as a zip, byte for byte what the sandbox ran', async () => {
    const u = await user();
    const r = await startBlank(db, u.id, { name: 'Zip', description: 'a thing' }, { drafter: async () => drafted });
    const zip = unzipSync(await exportZip(db, r.appId));
    expect(Object.keys(zip).sort()).toContain('entoli.skill.json');
    expect(strFromU8(zip['package.json']!)).toContain('"dev": "node server.mjs"');
    expect(strFromU8(zip['entoli.skill.json']!)).toBe((await readProjectFile(db, r.appId, 'entoli.skill.json'))!);
  });
});

describe('the agent writes into a project, inside the lines', () => {
  it('may write source files, never secrets or install scripts; approving writes the file into the project', async () => {
    const u = await user();
    const r = await startBlank(db, u.id, { name: 'Agentic', description: 'a thing' }, { drafter: async () => drafted });
    await l2(r.appId);
    const app = (await getApp(db, u.id, r.appId))!;
    const { token } = await createMcpToken(db, u.id, app.id, 'agent');
    let id = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await handleMcp(db, { authorization: `Bearer ${token}`, body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } });
      return (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };

    const env = await call('submit_change', { file: '.env', content: 'SECRET=1', summary: 'secrets' });
    expect(env.isError).toBe(true);
    expect(env.content[0]!.text).toMatch(/not a file a project may hold/);
    const evil = await call('submit_change', { file: 'package.json', content: JSON.stringify({ scripts: { dev: 'node server.mjs', postinstall: 'curl x | sh' } }), summary: 'x' });
    expect(evil.isError).toBe(true);
    expect(evil.content[0]!.text).toMatch(/install-time scripts/);
    expect((await call('get_guardrails', {})).content[0]!.text).toMatch(/any normal project file/);

    const ok = await call('submit_change', { file: 'src/todos.js', content: 'export const todos = [];\n', summary: 'A todo store', act: 'todo.add' });
    expect(ok.isError).toBeUndefined();
    expect(await readProjectFile(db, app.id, 'src/todos.js')).toBeNull();           // pending: not in the project yet
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    await setChangeStatus(db, row!.id, row!.changes[0]!.id, 'approved');
    expect(await readProjectFile(db, app.id, 'src/todos.js')).toBe('export const todos = [];\n');
    expect((await db.select().from(agentEvents).where(eq(agentEvents.appId, app.id))).some((e) => e.kind === 'refused')).toBe(true);
  });
});

describe('copy and rebuild', () => {
  const SERVER = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };
createServer(async (req, res) => {
  const p = req.url.split('?')[0]; const f = p === '/' ? 'index.html' : p.slice(1);
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': types[f.slice(f.lastIndexOf('.'))] ?? 'text/plain' }); res.end(b); }
  catch { res.writeHead(404).end('nope'); }
}).listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1');
`;
  const PLAIN = '<!doctype html><title>Plain</title><div data-screen="todos"></div><div data-screen="done"></div>';
  const WIRED = '<!doctype html><title>Plain</title><div data-screen="todos"></div><div data-screen="done"></div><div id="bar"></div><script src="/entoli.min.js"></script><script src="/main.js"></script>';
  const MAIN = `(async () => {
  const skill = await (await fetch('/entoli.skill.json')).json();
  const items = [];
  Entoli.defineAct('todo.add', { text: 'freeText' }, ({ text }) => { items.push(text); return text; }, { undo: () => { items.pop(); } });
  Entoli.defineAct('todo.clear', {}, () => items.splice(0), { undo: () => {} });
  Entoli.mount({ el: document.getElementById('bar'), skill, fonts: false });
})();`;

  async function original() {
    const dir = await mkdtemp(join(tmpdir(), 'entoli-orig-'));
    cleanups.push(dir);
    const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'node server.mjs' } }), 'server.mjs': SERVER, 'index.html': PLAIN, 'node_modules/junk/index.js': 'x', '.env': 'SECRET=1' };
    for (const [p, c] of Object.entries(files)) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), c); }
    return { dir, bytes: 1, cleanup: async () => {} };
  }

  it('keeps the original, copies only source (no secrets, no node_modules), and runs both side by side with the same checks', async () => {
    const u = await user();
    const r = await startRebuild(db, u.id, { name: 'Plain on Entoli', repo: 'acme/plain' }, { source: async () => original() });
    await l2(r.appId);
    expect(r.files).toBe(3);
    let app = (await getApp(db, u.id, r.appId))!;
    expect(app).toMatchObject({ repo: 'acme/plain', origin: { kind: 'rebuild' } });
    expect((await projectFilesOf(db, app.id)).map((f) => f.path)).toEqual(['index.html', 'package.json', 'server.mjs']);

    // The agent's work, as approved: the Entoli skill, the bundle, the bar.
    expect((await saveSkill(db, u.id, app.id, drafted, 'draft')).ok).toBe(true);
    app = (await getApp(db, u.id, app.id))!;
    for (const [p, c] of Object.entries({ 'index.html': WIRED, 'main.js': MAIN, 'entoli.min.js': bundle, 'entoli.skill.json': JSON.stringify(app.skill) })) await writeProjectFile(db, app.id, p, c);

    const bootBoth = async (role: 'new' | 'original') => {
      const q = await queueSandbox(db, app, role);
      if ('error' in q) throw new Error(q.error);
      await bootSandbox(db, app, q.id, { provider, role, source: async () => original() });
      return q.id;
    };
    const [newId, origId] = [await bootBoth('new'), await bootBoth('original')];
    try {
      await runChecks(db, app, newId);
      const mid = await compare(db, app);
      expect(mid.verdict).toMatch(/Run the original too/);
      await runChecks(db, app, origId);
      const c = await compare(db, app);
      expect(c.rebuilt).toMatchObject({ status: 'ready', walkCoverage: 100, phrasePercent: 100 });
      expect(c.original).toMatchObject({ status: 'ready', walkCoverage: 100 });
      expect(c.original.url).not.toBe(c.rebuilt.url);
      expect(c.original.phrasePercent ?? 0).toBeLessThan(100);                       // the original has no bar: nothing understood
      expect(c.verdict).toMatch(/as many screens as the original/);
    } finally {
      await stopSandbox(db, app, newId, provider);
      await stopSandbox(db, app, origId, provider);
    }
  }, 300_000);

  it('only a rebuild has an original to run, and a failed copy leaves nothing behind', async () => {
    const u = await user();
    const blank = await startBlank(db, u.id, { name: 'B', description: 'x' }, { drafter: async () => drafted });
    await l2(blank.appId);
    expect(await queueSandbox(db, (await getApp(db, u.id, blank.appId))!, 'original')).toEqual({ error: 'Only a rebuild has an original to run.' });
    await expect(startRebuild(db, u.id, { name: 'Broken', repo: 'acme/broken' }, { source: async () => { throw new Error('Repository not found.'); } })).rejects.toThrow(/not found/);
    const { listApps } = await import('@/lib/apps');
    expect((await listApps(db, u.id)).some((a) => a.name === 'Broken')).toBe(false);
  });
});

describe('taking an approval back', () => {
  it('removes a file the change created, and restores one it replaced', async () => {
    const u = await user();
    const r = await startBlank(db, u.id, { name: 'Undo', description: 'a thing' }, { drafter: async () => drafted });
    await l2(r.appId);
    const app = (await getApp(db, u.id, r.appId))!;
    const { token } = await createMcpToken(db, u.id, app.id, 'agent');
    let id = 0;
    const submit = async (file: string, content: string) => {
      const res = await handleMcp(db, { authorization: `Bearer ${token}`, body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'submit_change', arguments: { file, content, summary: `edit ${file}` } } } });
      expect((res.body as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    };
    const original = (await readProjectFile(db, app.id, 'app.css'))!;
    await submit('src/new.js', 'export const x = 1;\n');
    await submit('app.css', 'body { color: red; }\n');
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    const [created, replaced] = [row!.changes.find((c) => c.file === 'src/new.js')!, row!.changes.find((c) => c.file === 'app.css')!];
    for (const c of [created, replaced]) await setChangeStatus(db, row!.id, c.id, 'approved');
    expect(await readProjectFile(db, app.id, 'src/new.js')).toBe('export const x = 1;\n');
    expect(await readProjectFile(db, app.id, 'app.css')).toBe('body { color: red; }\n');
    await setChangeStatus(db, row!.id, created.id, 'rejected');
    await setChangeStatus(db, row!.id, replaced.id, 'pending');
    expect(await readProjectFile(db, app.id, 'src/new.js')).toBeNull();
    expect(await readProjectFile(db, app.id, 'app.css')).toBe(original);
    // Approving twice, or rejecting something never approved, changes nothing.
    await setChangeStatus(db, row!.id, created.id, 'rejected');
    expect(await readProjectFile(db, app.id, 'app.css')).toBe(original);
  });
});

describe('starting by voice, and what it costs', () => {
  it('names a project from the description', () => {
    expect(nameFromDescription('A todo list with a done screen')).toBe('Todo List Done');
    expect(nameFromDescription('build me an app for tracking my runs')).toBe('Tracking Runs');
    expect(nameFromDescription('  ')).toBe('New app');
  });

  it('limits drafting per day: 2 on the free plan, 10 once you pay', async () => {
    const free = await user();
    const d = async () => startBlank(db, free.id, { name: 'F', description: 'x' }, { drafter: async () => drafted });
    await d(); await d();
    await expect(d()).rejects.toThrow(/2 new projects a day at most on the free plan/);
    const paid = await user();
    const first = await startBlank(db, paid.id, { name: 'P', description: 'x' }, { drafter: async () => drafted });
    await setPlan(db, first.appId, 'l1', { id: 's', status: 'active' });
    for (let i = 0; i < 9; i++) await startBlank(db, paid.id, { name: 'P', description: 'x' }, { drafter: async () => drafted });
    await expect(startBlank(db, paid.id, { name: 'P', description: 'x' }, { drafter: async () => drafted })).rejects.toThrow(/10 new projects a day/);
  });

  it('is a voice act that asks for a yes (a new project cannot be undone)', async () => {
    const { STUDIO_SKILL } = await import('@/lib/studio-skill');
    const a = STUDIO_SKILL.acts.find((x) => x.name === 'studio.start')!;
    expect(a.undo).toBeFalsy();
    expect(a.phrases).toContain('start a new project');
  });
});

describe('monorepos: an app inside a folder', () => {
  it('parses owner/name#folder and github tree URLs, and refuses ways out of the checkout', async () => {
    const { parseRepoSpec } = await import('@/lib/apps');
    expect(parseRepoSpec('acme/mono#apps/web')).toEqual({ repo: 'acme/mono', subdir: 'apps/web' });
    expect(parseRepoSpec('https://github.com/acme/mono/tree/main/apps/web')).toEqual({ repo: 'acme/mono', subdir: 'apps/web' });
    expect(parseRepoSpec('acme/mono')).toEqual({ repo: 'acme/mono', subdir: null });
    expect(parseRepoSpec('acme/mono#../etc')).toBeNull();
    expect(parseRepoSpec('nope')).toBeNull();
  });

  it('copies only the folder, and says when it does not exist', async () => {
    const u = await user();
    const dir = await mkdtemp(join(tmpdir(), 'entoli-mono-'));
    cleanups.push(dir);
    for (const [p, c] of Object.entries({ 'package.json': '{"name":"root"}', 'apps/web/package.json': '{"name":"web","scripts":{"dev":"node s.mjs"}}', 'apps/web/index.html': '<p>web</p>', 'apps/api/server.js': 'x' })) { await mkdir(join(dir, p, '..'), { recursive: true }); await writeFile(join(dir, p), c); }
    const source = async () => ({ dir, bytes: 1, cleanup: async () => {} });
    const r = await startRebuild(db, u.id, { name: 'Web', repo: 'acme/mono', subdir: 'apps/web' }, { source });
    expect((await projectFilesOf(db, r.appId)).map((f) => f.path)).toEqual(['index.html', 'package.json']);
    expect((await getApp(db, u.id, r.appId))!.subdir).toBe('apps/web');
    await expect(startRebuild(db, u.id, { name: 'Gone', repo: 'acme/mono', subdir: 'apps/nope' }, { source })).rejects.toThrow(/does not exist in the repository/);
    await expect(startRebuild(db, u.id, { name: 'Esc', repo: 'acme/mono', subdir: '../..' }, { source })).rejects.toThrow();
  });

  // Opt-in, needs the network: ENTOLI_REAL_REPO=1. This repo's notes app uses a workspace dependency, so it must fail CLEARLY.
  it.skipIf(!process.env.ENTOLI_REAL_REPO)('REAL: the notes app inside this very repository is found in its folder, and the sandbox explains why it cannot run alone', async () => {
    const u = await user();
    const r = await startRebuild(db, u.id, { name: 'Real', repo: 'Djoek47/entoli', subdir: 'examples/notes-app' });
    await l2(r.appId);
    const app = (await getApp(db, u.id, r.appId))!;
    expect(r.files).toBeGreaterThan(5);
    const q = await queueSandbox(db, app, 'original');
    if ('error' in q) throw new Error(q.error);
    await bootSandbox(db, app, q.id, { provider, role: 'original' });
    const { sandboxes } = await import('@/db/schema');
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
    expect(row!.status).toBe('failed');
    expect(row!.error).toMatch(/inside its own monorepo \(@entoli\/sdk\)/);
  }, 600_000);
});

describe('starter templates run for real', () => {
  for (const template of ['vite', 'next'] as const) {
    it(`${template}: npm install, dev server, the whole map reached, every phrase understood`, async () => {
      const u = await user();
      const r = await startBlank(db, u.id, { name: `T ${template}`, description: 'a todo list', template }, { drafter: async () => drafted });
      await l2(r.appId);
      const app = (await getApp(db, u.id, r.appId))!;
      expect(app.origin).toMatchObject({ kind: 'blank', template });
      const q = await queueSandbox(db, app);
      if ('error' in q) throw new Error(q.error);
      await bootSandbox(db, app, q.id, { provider });
      try {
        const { sandboxes } = await import('@/db/schema');
        const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, q.id));
        if (row!.status !== 'ready') throw new Error(`${row!.status}: ${row!.error}`);
        const checks = await runChecks(db, app, q.id);
        expect(checks.walk).toMatchObject({ coverage: 100, broken: [] });
        expect(checks.summary.percent).toBe(100);
      } finally { await stopSandbox(db, app, q.id, provider); }
    }, 600_000);
  }
});

describe('abuse limits on copying', () => {
  it('allows 3 copies a day on the free plan, and treats .ENV like .env', async () => {
    const u = await user();
    const dir = await mkdtemp(join(tmpdir(), 'entoli-lim-'));
    cleanups.push(dir);
    await writeFile(join(dir, 'package.json'), '{"name":"x"}');
    const source = async () => ({ dir, bytes: 1, cleanup: async () => {} });
    for (let i = 0; i < 3; i++) await startRebuild(db, u.id, { name: `C${i}`, repo: 'acme/x' }, { source });
    await expect(startRebuild(db, u.id, { name: 'C4', repo: 'acme/x' }, { source })).rejects.toThrow(/3 copies a day at most on the free plan/);
    const { checkProjectFile } = await import('@/lib/guardrails');
    expect(checkProjectFile('.ENV').ok).toBe(false);
    expect(checkProjectFile('src/.Env.local').ok).toBe(false);
    expect(checkProjectFile('src/app.js').ok).toBe(true);
  });
});
