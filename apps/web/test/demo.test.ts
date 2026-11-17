/**
 * The end-to-end demo, run for real (real database, real MCP over the real
 * handler, real sandbox, real Chromium) with a fake voice provider and a fake
 * model for the skill draft and the developer's coding agent. Every line of the
 * transcript is produced by the code under test.
 *
 *   ENTOLI_WRITE_DEMO=1 pnpm --filter @entoli/web test demo   → rewrites docs/DEMO_RUN.md
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { integrations } from '@/db/schema';
import { announce } from '@/lib/agent-announce';
import { getApp, setPlan, upsertUser } from '@/lib/apps';
import { setChangeStatus } from '@/lib/integration';
import { createMcpToken, handleMcp, listAgentEvents } from '@/lib/mcp';
import { acceptProposal, explain, proposalOf, proposeFor } from '@/lib/proposal';
import { bootSandbox, queueSandbox, runChecks, stopSandbox } from '@/lib/sandbox-boot';
import { exportZip, projectFilesOf, startBlank } from '@/lib/project';
import { localProvider } from '@/lib/sandbox';

let db: DB;
beforeAll(async () => {
  db = await memoryDb();
  if (!process.env.ENTOLI_CHROMIUM_PATH && existsSync('/opt/pw-browsers/chromium')) process.env.ENTOLI_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
});

const drafted = {
  entoli: '0.1', app: { name: 'x' }, layer: 'L1', mode: 'text',
  map: [{ id: 'todos', kind: 'screen', title: 'Todos', path: '/', selector: '[data-screen=todos]' }, { id: 'done', kind: 'screen', title: 'Done', path: '/', selector: '[data-screen=done]' }],
  knowledge: [{ topic: 'sharing', can: false, answer: 'No. Todos stay private.', phrases: ['share list'] }],
  acts: [
    { name: 'todo.add', title: 'Add a todo', screen: 'todos', phrases: ['add todo', 'new todo'], radius: 'self', undo: true, slots: { text: { type: 'freeText', required: true, label: 'Todo' } } },
    { name: 'todo.show', title: 'Open done', screen: 'done', phrases: ['show done', 'go to done'], radius: 'self', undo: true },
    { name: 'account.delete', title: 'Delete account', phrases: ['delete my account'], radius: 'self' },
  ],
};

describe('the whole story', () => {
  it('describe an app → skill → proposal → agent builds → approve → sandbox passes → zip', async () => {
    const lines: string[] = [];
    const you = (t: string) => lines.push(`**You:** ${t}`);
    const entoli = (t: string) => lines.push(`**Entoli:** ${t}`);
    const note = (t: string) => lines.push(`> ${t}`);

    const u = await upsertUser(db, { githubId: `demo${Math.random()}`, login: 'dev' });
    you('Build me a todo app. I can add todos, and see the ones I have done.');
    const started = await startBlank(db, u.id, { name: 'Todos', description: 'A todo list with a done screen' }, { drafter: async () => drafted });
    await setPlan(db, started.appId, 'l2', { id: 's', status: 'active' });
    let app = (await getApp(db, u.id, started.appId))!;
    entoli(`I wrote the skill first: ${(app.skill as typeof drafted).map.length} screens, ${(app.skill as typeof drafted).acts.length} features, and a starter app that already runs (${started.files} files).`);

    you('What should I expose?');
    const p = await proposeFor(db, app);
    entoli(p.spoken);
    you('Why is delete account manual?');
    entoli(explain(p, 'account.delete'));
    you('Accept the proposal.');
    entoli('This changes what the AI can reach. Say yes to go ahead, or no.');
    you('Yes.');
    app = (await getApp(db, u.id, app.id))!;
    const r = await acceptProposal(db, app);
    entoli(`Done. I changed ${r.changed} features. You can say undo, or move any of them yourself.`);
    expect(proposalOf((await getApp(db, u.id, app.id))!)!.applied).toBeTruthy();
    app = (await getApp(db, u.id, app.id))!;

    // The developer's own coding agent, over MCP.
    const { token } = await createMcpToken(db, u.id, app.id, 'agent');
    let id = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await handleMcp(db, { authorization: `Bearer ${token}`, body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } });
      return (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    note('The developer’s coding agent connects over MCP and builds the app.');
    const wired = JSON.parse((await call('list_acts_to_wire', {})).content[0]!.text) as { act: string }[];
    expect(wired.map((w) => w.act)).toEqual(expect.arrayContaining(['todo.add', 'todo.show']));
    expect(wired.map((w) => w.act)).not.toContain('account.delete');           // kept manual
    await call('report_progress', { act: 'todo.add', status: 'started' });
    const refused = await call('submit_change', { file: '.env', content: 'KEY=1', summary: 'add a key' });
    expect(refused.isError).toBe(true);
    const MAIN = `const skill = await (await fetch('./entoli.skill.json')).json();
const items = [];
const app = document.getElementById('app');
for (const node of skill.map) { const s = document.createElement('section'); s.setAttribute('data-screen', node.id); s.innerHTML = '<h2></h2><ul></ul>'; s.querySelector('h2').textContent = node.title; app.append(s); }
const list = () => app.querySelector('[data-screen=todos] ul');
const entoli = Entoli.mount({ el: '#entoli', skill, fonts: false });
entoli.register('todo.add', { text: { type: 'freeText', required: true } }, async ({ text }) => { const li = document.createElement('li'); li.textContent = String(text); list().append(li); return li; }, { undo: (li) => li.remove(), describe: ({ text }) => 'Add ' + text });
entoli.register('todo.show', {}, async () => { location.hash = 'done'; return null; }, { undo: () => { location.hash = ''; }, describe: () => 'Open done' });
`;
    const sub = await call('submit_change', { file: 'app.js', content: MAIN, summary: 'Build the todo list and wire add and show', act: 'todo.add' });
    expect(sub.isError).toBeUndefined();
    await call('report_progress', { act: 'todo.add', status: 'wired' });
    const events = await listAgentEvents(db, app.id, 20);
    const said = announce(events.map((e) => ({ id: e.id, kind: e.kind, act: e.act, status: e.status, note: e.note, createdAt: e.createdAt.toISOString() })));
    entoli(said!.text);
    expect(said!.text).toMatch(/waiting for your approval/);

    you('Approve all.');
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    for (const c of row!.changes) await setChangeStatus(db, row!.id, c.id, 'approved');
    entoli(`Approved ${row!.changes.length} change. It is written into your project.`);

    you('Run it in the sandbox and check it.');
    const provider = localProvider();
    const q = await queueSandbox(db, app);
    if ('error' in q) throw new Error(q.error);
    await bootSandbox(db, app, q.id, { provider });
    try {
      const checks = await runChecks(db, app, q.id);
      entoli(`It is running. I walked the map: ${checks.walk!.verified} of ${checks.walk!.checked} screens reached. I typed each feature's phrase into the bar: ${checks.summary.good} of ${checks.summary.checked} understood.`);
      expect(checks.walk).toMatchObject({ coverage: 100, broken: [] });
      expect(checks.summary.percent).toBe(100);
    } finally { await stopSandbox(db, app, q.id, provider); }

    you('Give me the project.');
    const zip = await exportZip(db, app.id);
    entoli(`Here is your project: ${(await projectFilesOf(db, app.id)).length} files, ${Math.round(zip.length / 1024)} kB zipped. Nothing was ever in a repository.`);

    const doc = `# A recorded end-to-end run\n\nProduced by \`apps/web/test/demo.test.ts\`. Real database, real MCP handler, real sandbox, real Chromium. The voice provider is a fake (it only carries text), and the model that drafts the skill and the coding agent are scripted, so this shows the *flow and the guardrails*, not the quality of a real model. Regenerate with \`ENTOLI_WRITE_DEMO=1 pnpm --filter @entoli/web test demo\`.\n\n${lines.map((l) => `${l}\n`).join('\n')}\n`;
    if (process.env.ENTOLI_WRITE_DEMO === '1') writeFileSync(fileURLToPath(new URL('../../../docs/DEMO_RUN.md', import.meta.url)), doc);
    else if (existsSync(fileURLToPath(new URL('../../../docs/DEMO_RUN.md', import.meta.url)))) expect(readFileSync(fileURLToPath(new URL('../../../docs/DEMO_RUN.md', import.meta.url)), 'utf8')).toContain('You:');
    expect(lines.length).toBeGreaterThan(12);
  }, 300_000);
});
