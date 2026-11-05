import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { analyses, integrations } from '@/db/schema';
import { createApp, getApp, saveSkill, setPlan, setRepo, upsertUser } from '@/lib/apps';
import { blobSha, dirFiles, withDependency, generateIntegration, integrationAllowed, openPullRequest, parseAnswers, setChangeStatus, skillForAnswers, startIntegration, syntaxErrors, themeCss, type Answers, type Editor } from '@/lib/integration';
import skill from '../../../examples/notes-app/entoli.skill.json';

const notesDir = fileURLToPath(new URL('../../../examples/notes-app', import.meta.url));
let db: DB;
beforeAll(async () => { db = await memoryDb(); });

const answers: Answers = { features: ['note.create', 'note.search', 'settings.theme', 'settings.email'], layer: 'L2', mode: 'voice', design: 'entoli', settingsBy: 'admins', confirm: 'contract' };

async function setup(plan: 'developer' | 'l2' = 'l2') {
  const u = await upsertUser(db, { githubId: `i${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes', repo: 'acme/fieldnotes' });
  await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
  expect((await saveSkill(db, u.id, app.id, skill, 'published')).ok).toBe(true);
  await setPlan(db, app.id, plan, { id: 's', status: 'active' });
  await setRepo(db, u.id, app.id, 'acme/fieldnotes', '42');
  const at = (handler: string) => [{ file: 'src/App.tsx', line: 10, component: 'App', handler }];
  await db.insert(analyses).values({ appId: app.id, status: 'done', log: [], sources: { 'note.create': at('addNote'), 'note.search': at('setQuery'), 'settings.theme': at('setSettings'), 'settings.email': at('setSettings') } });
  return { user: u, app: (await getApp(db, u.id, app.id))! };
}

const wiring: Editor = vi.fn(async ({ content, acts }) => ({
  content: content.replace("export function App(", `${acts.map((a: { name: string }) => `// useEntoli('${a.name}', …) wired here`).join('\n')}\nexport function App(`),
  summary: `Wired ${acts.length} acts.`,
}));

describe('interview', () => {
  it('parses answers and keeps only real features', () => {
    expect(parseAnswers({ features: ['note.create', 'nope'], layer: 'L2', mode: 'voice', design: 'bogus' }, skill as never)).toMatchObject({ features: ['note.create'], layer: 'L2', mode: 'voice', design: 'entoli', settingsBy: 'admins', confirm: 'contract' });
    expect(parseAnswers({ features: [] }, skill as never)).toEqual({ error: 'Pick at least one feature.' });
  });

  it('drops settings from the skill on L1 or when nobody may change them', () => {
    const l1 = skillForAnswers(skill as never, { ...answers, layer: 'L1' });
    expect(l1.acts.map((a) => a.name)).toEqual(['note.create', 'note.search']);
    expect(l1.map.some((n) => n.act === 'settings.theme')).toBe(false);
    expect(skillForAnswers(skill as never, { ...answers, settingsBy: 'nobody' }).acts.map((a) => a.name)).toEqual(['note.create', 'note.search']);
  });

  it('is a paid feature', async () => {
    const { app } = await setup('developer');
    expect(integrationAllowed(app)).toMatch(/L2 plan/);
    expect(integrationAllowed({ ...app, plan: 'l1' })).toMatch(/coding agent/);
  });

  it('adds the SDK dependency, keeping the file\'s indentation', () => {
    const out = withDependency('{\n    "name": "x",\n    "dependencies": { "react": "^19.0.0" }\n}\n')!;
    expect(JSON.parse(out).dependencies).toEqual({ '@entoli/sdk': '^0.1.0', react: '^19.0.0' });
    expect(out).toContain('\n    "name"');
    expect(withDependency('not json')).toBeNull();
  });

  it('generates a theme from the app CSS variables', () => {
    const css = themeCss('generate', ':root{--ink:#111;--paper:#fff;--lime:#0f0;--accent:#f0f;}');
    expect(css).toContain('--e-ink: var(--ink)');
    expect(css).toContain('--e-paper: var(--paper)');
    expect(themeCss('entoli', null)).toBeNull();
  });
});

describe('generation', () => {
  it('prepares deterministic setup changes plus one Claude edit per file', async () => {
    const { app } = await setup();
    const row = await startIntegration(db, app, answers);
    await generateIntegration(db, app, row.id, { files: dirFiles(notesDir), edit: wiring, modelAvailable: true });
    const [r] = await db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(r!.status).toBe('generated');
    const files = r!.changes.map((c) => c.file);
    // Fieldnotes already depends on @entoli/sdk, so package.json is left alone.
    expect(files).toEqual(['entoli.skill.json', 'src/entoli.ts', 'src/main.tsx', 'src/App.tsx']);
    const by = Object.fromEntries(r!.changes.map((c) => [c.file, c]));
    const writtenSkill = JSON.parse(by['entoli.skill.json']!.content);
    expect(writtenSkill.acts.map((a: { name: string }) => a.name)).toEqual(['note.create', 'note.search', 'settings.theme', 'settings.email']);
    expect(writtenSkill.mode).toBe('voice');
    expect(by['src/entoli.ts']!.content).toContain("mode: 'voice'");
    expect(by['src/entoli.ts']!.content).toContain('key: import.meta.env.VITE_ENTOLI_KEY');
    expect(by['src/entoli.ts']!.content).toContain("import skill from '../entoli.skill.json';");
    expect(by['src/entoli.ts']!.baseSha).toBeNull();
    expect(by['src/main.tsx']!.content.startsWith("import './entoli';\n")).toBe(true);
    expect(by['src/App.tsx']!.diff).toContain("+// useEntoli('note.create', …) wired here");
    expect(by['src/App.tsx']!.summary).toBe('Wired 4 acts.');
    expect(r!.changes.every((c) => c.status === 'pending')).toBe(true);
    const edit = (wiring as unknown as { mock: { calls: [{ answers: Answers; sources: unknown[] }][] } }).mock.calls[0]![0];
    expect(edit.answers.settingsBy).toBe('admins');
    expect(edit.sources).toHaveLength(4);
  });

  it('refuses a model edit that does not parse, and explains it', async () => {
    const { app } = await setup();
    const row = await startIntegration(db, app, answers);
    const broken: Editor = async ({ content }) => ({ content: `${content}\nfunction (`, summary: 'oops' });
    await generateIntegration(db, app, row.id, { files: dirFiles(notesDir), edit: broken, modelAvailable: true });
    const [r] = await db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(r!.changes.map((c) => c.file)).not.toContain('src/App.tsx');
    expect(r!.error).toMatch(/did not parse/);
    expect(syntaxErrors('x.ts', 'const a = ;').length).toBeGreaterThan(0);
  });

  it('without a model, still prepares the setup and says what is left', async () => {
    const { app } = await setup();
    const row = await startIntegration(db, app, answers);
    await generateIntegration(db, app, row.id, { files: dirFiles(notesDir), modelAvailable: false });
    const [r] = await db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(r!.changes.map((c) => c.file)).toEqual(['entoli.skill.json', 'src/entoli.ts', 'src/main.tsx']);
    expect(r!.error).toMatch(/needs the model/);
  });
});

describe('pull request', () => {
  function github(contents: Record<string, string | null>) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://api.github.com', '');
      const method = init.method ?? 'GET';
      calls.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (path === '/repos/acme/fieldnotes') return json({ default_branch: 'main' });
      if (path === '/repos/acme/fieldnotes/git/ref/heads/main') return json({ object: { sha: 'head1' } });
      if (path === '/repos/acme/fieldnotes/git/commits/head1') return json({ tree: { sha: 'tree1' } });
      const m = /^\/repos\/acme\/fieldnotes\/contents\/(.+)\?ref=main$/.exec(path);
      if (m) {
        const c = contents[decodeURIComponent(m[1]!)];
        return c === undefined || c === null ? json({ message: 'Not Found' }, 404) : json({ sha: blobSha(c) });
      }
      if (path.endsWith('/git/trees')) return json({ sha: 'tree2' });
      if (path.endsWith('/git/commits')) return json({ sha: 'commit2' });
      if (path.endsWith('/git/refs')) return json({ ref: 'x' });
      if (path.endsWith('/pulls')) return json({ html_url: 'https://github.com/acme/fieldnotes/pull/7' });
      return json({ message: 'unexpected' }, 500);
    });
    return { f: f as unknown as typeof fetch, calls };
  }

  async function prepared() {
    const { app } = await setup();
    const row = await startIntegration(db, app, answers);
    const files = dirFiles(notesDir);
    await generateIntegration(db, app, row.id, { files, edit: wiring, modelAvailable: true });
    const [r] = await db.select().from(integrations).where(eq(integrations.id, row.id));
    return { app, row: r!, files };
  }

  it('commits only the approved changes, on a new branch, in one pull request', async () => {
    const { app, row, files } = await prepared();
    const pick = (file: string) => row.changes.find((c) => c.file === file)!;
    await setChangeStatus(db, row.id, pick('src/entoli.ts').id, 'approved');
    await setChangeStatus(db, row.id, pick('src/App.tsx').id, 'approved');
    await setChangeStatus(db, row.id, pick('entoli.skill.json').id, 'rejected');
    const gh = github({ 'src/App.tsx': (await files.read('src/App.tsx'))!, 'src/entoli.ts': null });
    const url = await openPullRequest(db, app, row.id, { fetch: gh.f, token: async () => 'ghs_write' });
    expect(url).toBe('https://github.com/acme/fieldnotes/pull/7');
    const tree = gh.calls.find((c) => c.path.endsWith('/git/trees'))!.body as { base_tree: string; tree: { path: string }[] };
    expect(tree.base_tree).toBe('tree1');
    expect(tree.tree.map((t) => t.path)).toEqual(['src/entoli.ts', 'src/App.tsx']);
    expect(gh.calls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')!.body).toMatchObject({ parents: ['head1'], tree: 'tree2' });
    expect(gh.calls.find((c) => c.path.endsWith('/git/refs'))!.body).toEqual({ ref: `refs/heads/entoli/integration-${row.id.slice(0, 8)}`, sha: 'commit2' });
    expect(gh.calls.find((c) => c.path.endsWith('/pulls'))!.body).toMatchObject({ head: `entoli/integration-${row.id.slice(0, 8)}`, base: 'main' });
    const [after] = await db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(after).toMatchObject({ status: 'pr_opened', prUrl: url });
  });

  it('refuses a file that changed on GitHub since it was read', async () => {
    const { app, row } = await prepared();
    await setChangeStatus(db, row.id, row.changes.find((c) => c.file === 'src/App.tsx')!.id, 'approved');
    const gh = github({ 'src/App.tsx': 'someone edited this meanwhile' });
    await expect(openPullRequest(db, app, row.id, { fetch: gh.f, token: async () => 't' })).rejects.toThrow(/changed on main/);
    expect(gh.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('needs an approval, and explains a missing write permission', async () => {
    const { app, row } = await prepared();
    await expect(openPullRequest(db, app, row.id, { token: async () => 't' })).rejects.toThrow(/Approve at least one/);
    await setChangeStatus(db, row.id, row.changes[0]!.id, 'approved');
    await expect(openPullRequest(db, app, row.id, { token: async () => { throw new Error('403'); } })).rejects.toThrow(/write access/);
  });
});
