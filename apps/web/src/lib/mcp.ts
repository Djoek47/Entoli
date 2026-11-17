/**
 * The Entoli MCP server: an orchestrator and a guardrail between the
 * developer's own coding agent (Claude Code, Cursor, …) and their repository.
 *
 * It does no heavy lifting. It tells the agent what Entoli does and what to
 * wire (instructions, the skill, the acts), limits what the agent may touch
 * (guardrails.ts), and carries the agent's reports and proposed changes back
 * to the developer. A proposed change is never written to the repository: it
 * becomes a pending diff in the Guided integration tab, approved one by one,
 * and only approved ones go into the pull request.
 *
 * Transport: MCP Streamable HTTP, stateless, JSON responses (no SSE).
 */
import { actLayer, type Skill } from '@entoli/sdk/skill';
import { createTwoFilesPatch } from 'diff';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '@/db';
import { agentEvents, apps, integrations, mcpTokens, type IntegrationChange } from '@/db/schema';
import { agentInstructions } from './agent-skill';
import { getApp, skillOf } from './apps';
import { allowedFiles, checkFile, checkProjectFile, checkSubmission, MAX_CHANGES } from './guardrails';
import { isProject, readProjectFile } from './project';
import { gh, installationToken } from './github';
import { blobSha, latestSources } from './integration';
import { generateMcpToken, hashKey, keyPrefix, looksLikeMcpToken } from './keys';
import { PLANS } from './plans';
import { describeTokens, themeCss as themeCssFromTokens } from '@entoli/design';
import { tokensOf } from './design';
import { hit } from './ratelimit';

type AppRow = typeof apps.$inferSelect;
type Fetch = typeof fetch;

export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---- tokens ---------------------------------------------------------------------------------------

export async function createMcpToken(db: DB, ownerId: string, appId: string, label = 'agent') {
  const app = await getApp(db, ownerId, appId);
  if (!app) throw new Error('App not found.');
  if (!PLANS[app.plan].integration) throw new Error('Connecting your own coding agent is part of the L2 plan.');
  const token = generateMcpToken();
  const [row] = await db.insert(mcpTokens).values({ appId, label: label.slice(0, 40) || 'agent', prefix: keyPrefix(token), hash: hashKey(token) }).returning();
  return { token, row: row! };
}

export async function listMcpTokens(db: DB, ownerId: string, appId: string) {
  if (!(await getApp(db, ownerId, appId))) return [];
  return db.select({ id: mcpTokens.id, label: mcpTokens.label, prefix: mcpTokens.prefix, createdAt: mcpTokens.createdAt, lastUsedAt: mcpTokens.lastUsedAt, revokedAt: mcpTokens.revokedAt })
    .from(mcpTokens).where(eq(mcpTokens.appId, appId)).orderBy(desc(mcpTokens.createdAt));
}

export async function revokeMcpToken(db: DB, ownerId: string, appId: string, tokenId: string) {
  if (!(await getApp(db, ownerId, appId))) return;
  await db.update(mcpTokens).set({ revokedAt: new Date() }).where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.appId, appId)));
}

async function appByMcpToken(db: DB, token: string): Promise<AppRow | null> {
  if (!looksLikeMcpToken(token)) return null;
  const [row] = await db.select({ app: apps, id: mcpTokens.id }).from(mcpTokens).innerJoin(apps, eq(apps.id, mcpTokens.appId))
    .where(and(eq(mcpTokens.hash, hashKey(token)), isNull(mcpTokens.revokedAt)));
  if (!row) return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.id));
  return row.app;
}

// ---- repository reads (base content for diffs and for the package.json rule) ---------------------------

export type BaseFile = { content: string; sha: string } | null;
export type FileReader = (app: AppRow, path: string) => Promise<BaseFile>;

export const githubFileReader = (f: Fetch = fetch): FileReader => async (app, path) => {
  if (!app.repo) return null;
  const url = `/repos/${app.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let res: Response;
  if (app.installationId) {
    const token = await installationToken(app.installationId, { repo: app.repo }, f);
    res = await f(`https://api.github.com${url}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'entoli' } });
  } else {
    res = await f(`https://api.github.com${url}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'entoli' } });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
  const j = (await res.json()) as { content?: string; encoding?: string; sha?: string };
  if (j.encoding !== 'base64' || typeof j.content !== 'string') return null;
  return { content: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha ?? '' };
};
void gh;

// ---- the agent's working record ---------------------------------------------------------------------------

async function log(db: DB, appId: string, kind: 'progress' | 'submit' | 'refused', act: string | null, status: string | null, note: string | null) {
  await db.insert(agentEvents).values({ appId, kind, act, status, note: note?.slice(0, 500) ?? null });
}

export function listAgentEvents(db: DB, appId: string, limit = 20) {
  return db.select().from(agentEvents).where(eq(agentEvents.appId, appId)).orderBy(desc(agentEvents.createdAt)).limit(limit);
}

async function agentIntegration(db: DB, app: AppRow, skill: Skill) {
  const rows = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(5);
  const open = rows.find((r) => r.status === 'generated' && (r.answers as { agent?: boolean }).agent === true);
  if (open) return open;
  const [created] = await db.insert(integrations).values({
    appId: app.id,
    answers: { agent: true, layer: skill.layer, mode: skill.mode, features: skill.acts.filter((a) => actLayer(skill, a) !== 'off').map((a) => a.name) },
    changes: [], status: 'generated',
  }).returning();
  return created!;
}

// ---- tools -----------------------------------------------------------------------------------------------------

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

export const GUIDANCE = `Entoli makes an app operable by intent, typed or spoken. You (the developer's own coding agent) write the code; Entoli tells you what to wire and keeps you inside the lines.

Start with get_instructions and list_acts_to_wire. For each act: edit the component that owns the function (useEntoli / defineAct from @entoli/sdk), then submit_change with the complete new file content. Nothing is written to the repository by you: every submission becomes a diff the developer approves in the dashboard, then one pull request is opened. Call report_progress as you go, and get_change_status to see what was approved.

Hard limits (get_guardrails lists the files): wire only acts that are in the skill and not set to "off"; never declare a weaker radius, drop exact or voiceOnly, or add undo the skill does not have; change package.json only to add @entoli/sdk; never edit files outside the allowed list.`;

const TOOLS = [
  { name: 'get_skill', description: 'The app\'s skill (entoli.skill.json): screens, acts with their layer, radius and undo, and what the app can and cannot do.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_guardrails', description: 'The rules you must stay within and the exact list of files you may submit changes for.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_acts_to_wire', description: 'Acts the developer exposed, with where each lives in the code and its current status (todo, started, wired, blocked) and any submitted change.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_instructions', description: 'Exact wiring instructions (Markdown) for this app: how to mount the bar, and one useEntoli snippet per act with its contract. Optionally only for some acts.', inputSchema: { type: 'object', properties: { acts: { type: 'array', items: { type: 'string' }, description: 'Act names. Omit for all.' } }, additionalProperties: false } },
  { name: 'get_design_tokens', description: 'The app\'s design system as Entoli extracted it from the code and the running app (colours, fonts, radius, shadow, dark mode), and the ready-made theme CSS for the Entoli bar and card. Use it so what you write looks native; do not invent styles.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'report_progress', description: 'Tell the developer what you are doing. Shown in the dashboard and spoken in the voice conversation.', inputSchema: { type: 'object', required: ['status'], properties: { act: { type: 'string' }, status: { type: 'string', enum: ['started', 'wired', 'blocked'] }, note: { type: 'string', maxLength: 500 } }, additionalProperties: false } },
  { name: 'submit_change', description: 'Propose a complete new version of one file. It is checked against the guardrails, then waits for the developer\'s approval; it is never written to the repository directly. Submit the same file again to revise it.', inputSchema: { type: 'object', required: ['file', 'content', 'summary'], properties: { file: { type: 'string', description: 'Repository-relative path' }, content: { type: 'string', description: 'The complete new file content' }, summary: { type: 'string', maxLength: 300 }, act: { type: 'string', description: 'The act this change wires, if one' } }, additionalProperties: false } },
  { name: 'get_change_status', description: 'Status of every change you submitted: pending, approved or rejected by the developer, and the pull request when opened.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export type McpDeps = { read?: FileReader };

async function callTool(db: DB, app: AppRow, name: string, args: Record<string, unknown>, deps: McpDeps): Promise<ToolResult> {
  const skill = skillOf(app);
  if (!skill) return text('This app has no valid skill yet. The developer must analyze the repository or write a skill in the dashboard first.', true);
  const sources = await latestSources(db, app.id);
  const project = isProject(app);
  const allowed = allowedFiles(skill, sources);

  switch (name) {
    case 'get_skill':
      return json(skill);

    case 'get_guardrails':
      return json({
        rules: [
          'Wire only acts that are in the skill and are not set to "off".',
          'Never declare a weaker radius, drop exact or voiceOnly, or add an undo the skill does not have.',
          'The act name and the options object must be literals, so they can be checked.',
          'package.json may only gain "@entoli/sdk" in dependencies.',
          'entoli.skill.json may only be tightened: never add acts, loosen the contract, or give the AI more reach.',
          project ? 'This is a project built on Entoli: you may write any normal source file, never secrets (.env), git data or node_modules. package.json may not have install-time scripts. Nothing is written until the developer approves each diff.' : 'You cannot write to the repository. submit_change creates a diff the developer approves.',
        ],
        allowedFiles: project ? 'any normal project file' : allowed,
        limits: { maxChanges: MAX_CHANGES, maxFileKilobytes: 200 },
      });

    case 'list_acts_to_wire': {
      const events = await listAgentEvents(db, app.id, 200);
      const [row] = await db.select().from(integrations).where(eq(integrations.appId, app.id)).orderBy(desc(integrations.createdAt)).limit(1);
      const changes = row?.changes ?? [];
      return json(skill.acts.filter((a) => actLayer(skill, a) !== 'off').map((a) => {
        const last = events.find((e) => e.kind === 'progress' && e.act === a.name);
        const files = (sources[a.name] ?? []).map((s) => s.file);
        return {
          act: a.name, title: a.title ?? a.name, layer: actLayer(skill, a), radius: a.radius, undo: !!a.undo, exact: !!a.exact, voiceOnly: !!a.voiceOnly, setting: a.kind === 'setting',
          slots: Object.fromEntries(Object.entries(a.slots ?? {}).map(([k, s]) => [k, s.type])),
          where: (sources[a.name] ?? []).slice(0, 3),
          status: last?.status ?? 'todo',
          submittedChanges: changes.filter((c) => files.includes(c.file)).map((c) => ({ file: c.file, status: c.status })),
        };
      }));
    }

    case 'get_design_tokens': {
      const tokens = tokensOf(app.design as never);
      if (!tokens) return text('No design system has been extracted yet. Ask the developer to extract it in the dashboard (Design tab), or say "match my design" in the voice tool.', true);
      return json({ summary: describeTokens(tokens), tokens, themeCss: themeCssFromTokens(tokens), howToUse: 'Save themeCss as entoli.theme.css (submit_change allows it) and import it where the bar is mounted. The bar and card follow these tokens; no other styling is needed.' });
    }

    case 'get_instructions': {
      const only = Array.isArray(args.acts) ? args.acts.filter((x): x is string => typeof x === 'string') : undefined;
      return text(agentInstructions(skill, sources, only));
    }

    case 'report_progress': {
      const status = args.status;
      if (status !== 'started' && status !== 'wired' && status !== 'blocked') return text('status must be "started", "wired" or "blocked".', true);
      const act = typeof args.act === 'string' ? args.act : null;
      if (act && !skill.acts.some((a) => a.name === act)) return text(`"${act}" is not an act in the skill.`, true);
      await log(db, app.id, 'progress', act, status, typeof args.note === 'string' ? args.note : null);
      return text('Noted. The developer can see it in the dashboard.');
    }

    case 'submit_change': {
      const file = typeof args.file === 'string' ? args.file : '';
      const content = typeof args.content === 'string' ? args.content : null;
      const summary = typeof args.summary === 'string' ? args.summary.slice(0, 300) : '';
      if (content === null || !summary) return text('file, content (the complete new file) and summary are required.', true);
      const refuse = async (reasons: string[]) => { await log(db, app.id, 'refused', typeof args.act === 'string' ? args.act : null, 'refused', `${file}: ${reasons[0]}`); return text(`Refused, nothing was submitted:\n- ${reasons.join('\n- ')}`, true); };

      const f = project ? checkProjectFile(file) : checkFile(file, allowed);
      if (!f.ok) return refuse(f.reasons);
      const path = f.path!;
      let base: BaseFile = null;
      try { base = project ? await readProjectFile(db, app.id, path).then((c) => (c === null ? null : { content: c, sha: '' })) : await (deps.read ?? githubFileReader())(app, path); }
      catch (e) { return text(`Could not read ${path} from the repository to compare against: ${(e as Error).message}. Try again.`, true); }
      const v = checkSubmission({ path, content, base: base?.content ?? null, skill, project });
      if (!v.ok) return refuse(v.reasons);
      if (base && base.content === content) return text('That is identical to the current file; nothing to submit.', true);

      const row = await agentIntegration(db, app, skill);
      const existing = row.changes.find((c) => c.file === path);
      if (!existing && row.changes.length >= MAX_CHANGES) return refuse([`Too many changes in one integration (${MAX_CHANGES}). Ask the developer to open the pull request first.`]);
      const change: IntegrationChange = {
        id: existing?.id ?? randomUUID().slice(0, 8),
        title: summary, file: path, content, status: 'pending', summary,
        baseSha: base ? (base.sha || blobSha(base.content)) : null,
        diff: createTwoFilesPatch(base ? `a/${path}` : '/dev/null', `b/${path}`, base?.content ?? '', content, '', '', { context: 3 }),
      };
      const changes = existing ? row.changes.map((c) => (c.file === path ? change : c)) : [...row.changes, change];
      await db.update(integrations).set({ changes }).where(eq(integrations.id, row.id));
      await log(db, app.id, 'submit', typeof args.act === 'string' ? args.act : null, existing ? 'revised' : 'submitted', `${path}: ${summary}`);
      return json({ changeId: change.id, status: 'pending', message: 'Submitted. It is not in the repository: the developer reviews this diff in the dashboard (Guided integration) and approves or rejects it. Call get_change_status to see the outcome.', warnings: v.warnings });
    }

    case 'get_change_status': {
      const [row] = await db.select().from(integrations).where(and(eq(integrations.appId, app.id))).orderBy(desc(integrations.createdAt)).limit(1);
      return json({ pullRequest: row?.prUrl ?? null, changes: (row?.changes ?? []).map((c) => ({ changeId: c.id, file: c.file, status: c.status, summary: c.summary })) });
    }

    default:
      return text(`Unknown tool "${name}".`, true);
  }
}

// ---- JSON-RPC over HTTP ---------------------------------------------------------------------------------------------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const rpcError = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleOne(db: DB, app: AppRow, m: Rpc, deps: McpDeps): Promise<unknown | null> {
  if (m.id === undefined) return null; // a notification (e.g. notifications/initialized): no response
  switch (m.method) {
    case 'initialize': {
      const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
      return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'entoli', version: '0.1.0' }, instructions: GUIDANCE } };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: m.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = typeof m.params?.name === 'string' ? m.params.name : '';
      if (!TOOLS.some((t) => t.name === name)) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
      const args = (m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {}) as Record<string, unknown>;
      try { return { jsonrpc: '2.0', id: m.id, result: await callTool(db, app, name, args, deps) }; }
      catch (e) { console.error('[mcp] tool failed', name, e); return { jsonrpc: '2.0', id: m.id, result: text('The tool failed on our side; try again.', true) }; }
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export type McpResponse = { status: number; body?: unknown; headers?: Record<string, string> };

export async function handleMcp(db: DB, input: { authorization: string | null; body: unknown }, deps: McpDeps = {}): Promise<McpResponse> {
  const token = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7).trim() : '';
  const app = token ? await appByMcpToken(db, token) : null;
  if (!app) return { status: 401, body: { error: 'invalid or revoked token' }, headers: { 'www-authenticate': 'Bearer realm="entoli"' } };
  if (!PLANS[app.plan].integration) return { status: 402, body: { error: 'Connecting your own coding agent is part of the L2 plan.' } };
  if (!(await hit(db, `mcp:${app.id}`, 120)).ok) return { status: 429, body: { error: 'rate limit' }, headers: { 'retry-after': '30' } };

  const b = input.body;
  if (Array.isArray(b)) {
    if (!b.length || b.length > 20) return { status: 400, body: rpcError(null, -32600, 'Invalid batch') };
    const out = (await Promise.all(b.map((m) => handleOne(db, app, m as Rpc, deps)))).filter((x) => x !== null);
    return out.length ? { status: 200, body: out } : { status: 202 };
  }
  if (!b || typeof b !== 'object' || (b as Rpc).jsonrpc !== '2.0') return { status: 400, body: rpcError(null, -32600, 'Invalid request') };
  const r = await handleOne(db, app, b as Rpc, deps);
  return r === null ? { status: 202 } : { status: 200, body: r };
}
