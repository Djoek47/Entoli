import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { analyses, integrations } from '@/db/schema';
import { createApp, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { setChangeStatus } from '@/lib/integration';
import { createMcpToken, handleMcp, listAgentEvents, listMcpTokens, revokeMcpToken, type FileReader } from '@/lib/mcp';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
const servers: Server[] = [];
beforeAll(async () => { db = await memoryDb(); });
afterAll(() => servers.forEach((s) => s.close()));

const REPO: Record<string, string> = {
  'src/App.tsx': "import { useState } from 'react';\nexport function App() {\n  const [n, setN] = useState(0);\n  return null;\n}\n",
  'package.json': JSON.stringify({ name: 'fieldnotes', dependencies: { react: '^18.0.0' } }, null, 2),
};
const read: FileReader = async (_app, path) => (path in REPO ? { content: REPO[path]!, sha: `sha-${path}` } : null);

async function setup(plan: 'l1' | 'l2' = 'l2') {
  const u = await upsertUser(db, { githubId: `m${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes', repo: 'acme/fieldnotes' });
  await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
  expect((await saveSkill(db, u.id, app.id, skill, 'draft')).ok).toBe(true);
  await setPlan(db, app.id, plan, { id: 's', status: 'active' });
  const at = (handler: string) => [{ file: 'src/App.tsx', line: 10, component: 'App', handler }];
  await db.insert(analyses).values({ appId: app.id, status: 'done', log: [], sources: { 'note.create': at('addNote'), 'settings.email': at('setSettings') } });
  return { user: u, app };
}

/** Our handler behind a real HTTP server, so a real MCP client can talk to it. */
function serve(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let raw = '';
      for await (const c of req) raw += c;
      const r = await handleMcp(db, { authorization: req.headers.authorization ?? null, body: JSON.parse(raw) }, { read });
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`); });
  });
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: !!r.isError };
};

describe('a real MCP client (the official SDK) talking to Entoli', () => {
  it('connects, receives the orchestration guidance, lists the tools, and runs the whole loop', async () => {
    const { user, app } = await setup();
    const { token } = await createMcpToken(db, user.id, app.id, 'Claude Code');
    const url = await serve();
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

    expect(client.getServerVersion()).toMatchObject({ name: 'entoli' });
    expect(client.getInstructions()).toMatch(/Nothing is written to the repository by you/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(['get_skill', 'get_guardrails', 'list_acts_to_wire', 'get_instructions', 'report_progress', 'submit_change', 'get_change_status']);

    const todo = JSON.parse((await call(client, 'list_acts_to_wire')).text) as { act: string; status: string; where: { file: string }[] }[];
    expect(todo.find((a) => a.act === 'note.create')).toMatchObject({ status: 'todo', where: [{ file: 'src/App.tsx' }] });
    expect((await call(client, 'get_instructions', { acts: ['note.create'] })).text).toContain("useEntoli('note.create'");
    expect(JSON.parse((await call(client, 'get_guardrails')).text).allowedFiles).toContain('src/App.tsx');

    await call(client, 'report_progress', { act: 'note.create', status: 'started', note: 'wiring addNote' });
    const wired = REPO['src/App.tsx']!.replace('  return null;', "  useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), { undo: (r) => removeNote(r) });\n  return null;");
    const sub = await call(client, 'submit_change', { file: 'src/App.tsx', content: wired, summary: 'Wire new note', act: 'note.create' });
    expect(sub.isError).toBe(false);
    const { changeId } = JSON.parse(sub.text) as { changeId: string };

    // Nothing is approved yet; the developer's side sees a pending diff.
    expect(JSON.parse((await call(client, 'get_change_status')).text).changes).toEqual([{ changeId, file: 'src/App.tsx', status: 'pending', summary: 'Wire new note' }]);
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    expect(row!.changes[0]).toMatchObject({ file: 'src/App.tsx', status: 'pending', baseSha: 'sha-src/App.tsx' });
    expect(row!.changes[0]!.diff).toContain("+  useEntoli('note.create'");

    // The developer approves in the dashboard; the agent sees it.
    await setChangeStatus(db, row!.id, changeId, 'approved');
    expect(JSON.parse((await call(client, 'get_change_status')).text).changes[0].status).toBe('approved');

    await call(client, 'report_progress', { act: 'note.create', status: 'wired' });
    const events = await listAgentEvents(db, app.id);
    expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual(['progress:wired', 'submit:submitted', 'progress:started']);
    await client.close();
  });

  it('refuses out-of-bounds submissions with reasons, and writes nothing', async () => {
    const { user, app } = await setup();
    const { token } = await createMcpToken(db, user.id, app.id);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(await serve()), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['a file outside the allowed list', { file: '.github/workflows/deploy.yml', content: 'on: push', summary: 's' }, /not a file this integration may touch/],
      ['a path that escapes the repo', { file: '../outside.ts', content: 'x', summary: 's' }, /not a valid repository path/],
      ['an act that is not in the skill', { file: 'src/App.tsx', content: "useEntoli('account.delete', {}, f);", summary: 's' }, /not an act in the skill/],
      ['a weaker contract', { file: 'src/App.tsx', content: "useEntoli('settings.email', {}, f, { radius: 'self' });", summary: 's' }, /weaker than the skill's "external"/],
      ['code that does not parse', { file: 'src/App.tsx', content: 'const = ;', summary: 's' }, /does not parse/],
      ['extra dependencies', { file: 'package.json', content: JSON.stringify({ name: 'fieldnotes', dependencies: { react: '^18.0.0', evil: '1.0.0', '@entoli/sdk': '^0.1.0' } }), summary: 's' }, /beyond adding/],
      ['new acts in the skill', { file: 'entoli.skill.json', content: JSON.stringify({ ...skill, acts: [...skill.acts, { name: 'wipe', phrases: ['wipe'], radius: 'self' }] }), summary: 's' }, /adds the act "wipe"/],
    ];
    for (const [label, args, why] of cases) {
      const r = await call(client, 'submit_change', args);
      expect(r.isError, label).toBe(true);
      expect(r.text, label).toMatch(why);
    }
    const rows = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    expect(rows.flatMap((r) => r.changes)).toEqual([]);
    expect((await listAgentEvents(db, app.id, 50)).filter((e) => e.kind === 'refused')).toHaveLength(cases.length);

    // An act set to "off" cannot be wired, even though its file is otherwise fine.
    expect((await saveSkill(db, user.id, app.id, { ...skill, acts: skill.acts.map((a) => (a.name === 'note.create' ? { ...a, layer: 'off' } : a)) }, 'draft')).ok).toBe(true);
    expect((await call(client, 'submit_change', { file: 'src/App.tsx', content: "useEntoli('note.create', {}, f);", summary: 's' })).text).toMatch(/"off"/);
    expect(JSON.parse((await call(client, 'list_acts_to_wire')).text).map((a: { act: string }) => a.act)).not.toContain('note.create');
    await client.close();
  });

  it('a revised submission replaces the earlier one and goes back to pending', async () => {
    const { user, app } = await setup();
    const { token } = await createMcpToken(db, user.id, app.id);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(await serve()), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const v1 = await call(client, 'submit_change', { file: 'src/App.tsx', content: `${REPO['src/App.tsx']}// v1\n`, summary: 'first' });
    const { changeId } = JSON.parse(v1.text) as { changeId: string };
    const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    await setChangeStatus(db, row!.id, changeId, 'rejected');
    const v2 = await call(client, 'submit_change', { file: 'src/App.tsx', content: `${REPO['src/App.tsx']}// v2\n`, summary: 'second' });
    expect(JSON.parse(v2.text).changeId).toBe(changeId);
    const [after] = await db.select().from(integrations).where(eq(integrations.appId, app.id));
    expect(after!.changes).toHaveLength(1);
    expect(after!.changes[0]).toMatchObject({ status: 'pending', summary: 'second' });
    expect(after!.changes[0]!.content).toContain('// v2');
    expect((await call(client, 'submit_change', { file: 'src/App.tsx', content: REPO['src/App.tsx'], summary: 'noop' })).text).toMatch(/identical/);
    await client.close();
  });
});

describe('access', () => {
  it('needs a valid token and the L2 plan; tokens are hashed and revocable', async () => {
    const { user, app } = await setup();
    const { token, row } = await createMcpToken(db, user.id, app.id);
    const ping = (authorization: string | null) => handleMcp(db, { authorization, body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, { read });
    expect((await ping(null)).status).toBe(401);
    expect((await ping('Bearer em_nope')).status).toBe(401);
    expect((await ping(`Bearer ${token}`)).status).toBe(200);
    expect((await listMcpTokens(db, user.id, app.id))[0]).toMatchObject({ prefix: token.slice(0, 12), revokedAt: null });
    expect(JSON.stringify(await listMcpTokens(db, user.id, app.id))).not.toContain(token);
    await revokeMcpToken(db, user.id, app.id, row.id);
    expect((await ping(`Bearer ${token}`)).status).toBe(401);

    const l1 = await setup('l1');
    await expect(createMcpToken(db, l1.user.id, l1.app.id)).rejects.toThrow(/L2 plan/);
    const stranger = await upsertUser(db, { githubId: 'stranger-m', login: 's' });
    await expect(createMcpToken(db, stranger.id, app.id)).rejects.toThrow(/not found/);
  });

  it('speaks JSON-RPC properly: notifications get no reply, unknown methods and tools are errors, batches work', async () => {
    const { user, app } = await setup();
    const { token } = await createMcpToken(db, user.id, app.id);
    const send = (body: unknown) => handleMcp(db, { authorization: `Bearer ${token}`, body }, { read });
    expect(await send({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202 });
    expect((await send({ jsonrpc: '2.0', id: 1, method: 'nope' })).body).toMatchObject({ error: { code: -32601 } });
    expect((await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } })).body).toMatchObject({ error: { code: -32602 } });
    expect((await send({ id: 3 })).status).toBe(400);
    const batch = await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect((batch.body as unknown[]).length).toBe(2);
    expect((await send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  it('an app with no valid skill gets a clear message instead of tools that guess', async () => {
    const u = await upsertUser(db, { githubId: `m${Math.random()}`, login: 'dev' });
    const { app } = await createApp(db, u.id, { name: 'Blank' });
    await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
    const { token } = await createMcpToken(db, u.id, app.id);
    const r = await handleMcp(db, { authorization: `Bearer ${token}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_skill', arguments: {} } } }, { read });
    expect(r.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('no valid skill') }] } });
  });
});
