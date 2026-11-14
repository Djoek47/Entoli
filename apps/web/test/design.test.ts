import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { memoryDb, type DB } from '@/db';
import { apps, integrations } from '@/db/schema';
import { createApp, getApp, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { extractFromRepo, resetTweaks, sampleFromUrl, tokensOf, tweakDesign } from '@/lib/design';
import { generateIntegration, dirFiles, startIntegration, type Editor } from '@/lib/integration';
import { createMcpToken, handleMcp } from '@/lib/mcp';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
const dirs: string[] = [];
const servers: Server[] = [];
beforeAll(async () => {
  db = await memoryDb();
  if (!process.env.ENTOLI_CHROMIUM_PATH && existsSync('/opt/pw-browsers/chromium')) process.env.ENTOLI_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
});
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); servers.forEach((s) => s.close()); });

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'entoli-design-repo-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  return { dir, bytes: 1, cleanup: async () => {} };
}
async function setup(plan: 'l1' | 'l2' = 'l2') {
  const u = await upsertUser(db, { githubId: `d${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes', repo: 'acme/fieldnotes' });
  await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
  expect((await saveSkill(db, u.id, app.id, skill, 'draft')).ok).toBe(true);
  await setPlan(db, app.id, plan, { id: 's', status: 'active' });
  return { user: u, get: async () => (await getApp(db, u.id, app.id))!, app };
}

const CSS = ':root{--bg:#fffdf8;--fg:#1b1b1b;--brand:#c2410c;--radius:10px;--font-body:"Inter",sans-serif}[data-theme="dark"]{--bg:#14110f;--fg:#f4efe8}';

describe('extracting and keeping the design', () => {
  it('extracts from the repo, keeps tweaks on top, and survives re-extraction', async () => {
    const t = await setup();
    const a = await t.get();
    const r = await extractFromRepo(db, a, { source: async () => repo({ 'src/index.css': CSS }) });
    expect(r.tokens.colors).toMatchObject({ background: '#fffdf8', foreground: '#1b1b1b', accent: '#c2410c' });
    expect(r.tokens.radius).toBe(10);
    expect(r.tokens.dark).toMatchObject({ background: '#14110f' });
    expect(r.tokens.colors.surface).toBe('#fffdf8'); // derived: the app defines no card colour

    const tweaked = await tweakDesign(db, await t.get(), 'rounder');
    expect(tweaked).toMatchObject({ understood: true, tokens: { radius: 16 } });
    expect((await tweakDesign(db, await t.get(), 'make the accent blue')).tokens.colors.accent).toBe('#2563eb');
    expect((await tweakDesign(db, await t.get(), 'purple monkey dishwasher')).understood).toBe(false);

    // The app changes; extract again: the new colours arrive, the tweaks stay.
    const again = await extractFromRepo(db, await t.get(), { source: async () => repo({ 'src/index.css': CSS.replace('#fffdf8', '#ffffff').replace('--radius:10px', '--radius:4px') }) });
    expect(again.tokens.colors.background).toBe('#ffffff');
    expect(again.tokens).toMatchObject({ radius: 10, colors: { accent: '#2563eb' } }); // 4px + "rounder" (+6)
    expect(tokensOf((await t.get()).design)!.sources.radius).toBe('voice');

    const reset = await resetTweaks(db, await t.get());
    expect(reset).toMatchObject({ radius: 4, colors: { accent: '#c2410c' } });
  });

  it('is part of the L2 plan, and tweaks need something extracted first', async () => {
    const l1 = await setup('l1');
    await expect(extractFromRepo(db, await l1.get(), { source: async () => repo({}) })).rejects.toThrow(/L2 plan/);
    const l2 = await setup('l2');
    await expect(tweakDesign(db, await l2.get(), 'rounder')).rejects.toThrow(/Extract the design first/);
  });

  it('samples the running app in a real browser, and the runtime wins over the code', async () => {
    const t = await setup();
    await extractFromRepo(db, await t.get(), { source: async () => repo({ 'src/index.css': CSS }) });
    const server = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{background:#101418;color:#e8eaed;font-family:Georgia,serif}button{background:#7c3aed;color:#fff;border:0;border-radius:6px;padding:8px}</style><h1>Hi</h1><button>Save</button>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const tokens = await sampleFromUrl(db, await t.get(), url);
    expect(tokens.colors).toMatchObject({ background: '#101418', foreground: '#e8eaed', accent: '#7c3aed' });
    expect(tokens.radius).toBe(6);
    expect(tokens.sources['colors.accent']).toMatch(/^runtime/);
    expect(tokens.dark).toMatchObject({ background: '#14110f' }); // dark mode still comes from the code
  }, 120_000);
});

describe('the design reaches the integration and the developer\'s agent', () => {
  it('the generated theme file follows the extracted design (unless the developer chose Entoli\'s own)', async () => {
    const t = await setup();
    await extractFromRepo(db, await t.get(), { source: async () => repo({ 'src/index.css': CSS }) });
    const app = await t.get();
    const noEdit: Editor = async ({ content }) => ({ content, summary: 'noop' });
    const run = async (design: 'theirs' | 'entoli') => {
      const row = await startIntegration(db, app, { features: ['note.create'], layer: 'L1', mode: 'text', design, settingsBy: 'admins', confirm: 'contract' });
      await generateIntegration(db, app, row.id, { files: dirFiles(new URL('../../../examples/notes-app', import.meta.url).pathname), edit: noEdit, modelAvailable: false });
      return (await db.select().from(integrations).where(eq(integrations.id, row.id)))[0]!.changes;
    };
    const theirs = (await run('theirs')).find((c) => c.file === 'src/entoli.theme.css')!;
    expect(theirs.content).toContain('--e-lime:#c2410c');
    expect(theirs.content).toContain('--e-radius:10px');
    expect(theirs.content).toContain('.dark .entoli');
    expect((await run('entoli')).some((c) => c.file === 'src/entoli.theme.css')).toBe(false);
  });

  it('the agent can fetch the tokens and ready-made theme over MCP', async () => {
    const t = await setup();
    const { token } = await createMcpToken(db, t.user.id, t.app.id);
    const call = async () => (await handleMcp(db, { authorization: `Bearer ${token}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_design_tokens', arguments: {} } } }, {})).body as { result: { isError?: boolean; content: { text: string }[] } };
    const before = await call();
    expect(before.result.isError).toBe(true);
    expect(before.result.content[0]!.text).toMatch(/No design system has been extracted/);
    await extractFromRepo(db, await t.get(), { source: async () => repo({ 'src/index.css': CSS }) });
    const after = JSON.parse((await call()).result.content[0]!.text);
    expect(after.tokens.colors.accent).toBe('#c2410c');
    expect(after.themeCss).toContain('--e-lime:#c2410c');
    expect(after.summary).toMatch(/#c2410c accent/);
    void apps;
  });
});
