/**
 * Guided integration (paid): interview → generated changes, one per file →
 * each approved or rejected by the developer → ONE pull request.
 *
 *   new files (skill, bootstrap, theme) and package.json   deterministic
 *   edits to existing components (wiring useEntoli)        Claude, per file,
 *                                                          syntax-checked
 *
 * Nothing is written to the repository until the developer opens the pull
 * request, and only approved changes go in it. Write access to GitHub is
 * requested at that moment only. A file that changed on GitHub since it was
 * read is refused rather than overwritten.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { askJson, hasAnthropicKey } from '@entoli/analyzer';
import { validateSkill, type Skill } from '@entoli/sdk/skill';
import { createTwoFilesPatch } from 'diff';
import { and, desc, eq } from 'drizzle-orm';
import ts from 'typescript';
import type { DB } from '@/db';
import { analyses, integrations, type IntegrationChange } from '@/db/schema';
import { skillOf } from './apps';
import { gh, installationToken } from './github';
import { PLANS } from './plans';

export type Answers = {
  features: string[];
  layer: 'L1' | 'L2';
  mode: 'text' | 'voice';
  design: 'entoli' | 'theirs' | 'generate';
  settingsBy: 'anyone' | 'admins' | 'nobody';
  confirm: 'contract' | 'always';
};

export const QUESTIONS = {
  layer: { q: 'Which layer by default? (each feature can be changed later)', options: [['L1', 'Layer 1: the device answers, no AI'], ['L2', 'Layer 2: Entoli AI answers, then makes the change']] },
  mode: { q: 'Text, or voice too?', options: [['text', 'Text only (cheapest)'], ['voice', 'Voice and text']] },
  design: { q: 'How should the bar and the card look?', options: [['entoli', "Copy Entoli's design"], ['theirs', 'Inherit your fonts and colours'], ['generate', 'Generate a theme from your CSS variables']] },
  settingsBy: { q: 'Who may change settings through Entoli?', options: [['anyone', 'Any signed-in user'], ['admins', 'Admins only'], ['nobody', 'Nobody (settings stay manual)']] },
  confirm: { q: 'How should actions be confirmed?', options: [['contract', 'Short hold with undo for small things; a yes for the rest'], ['always', 'Always ask for a yes']] },
} as const;

export function parseAnswers(form: Record<string, unknown>, skill: Skill): Answers | { error: string } {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const names = new Set(skill.acts.map((a) => a.name));
  const features = (Array.isArray(form.features) ? form.features : [form.features]).filter((f): f is string => typeof f === 'string' && names.has(f));
  if (!features.length) return { error: 'Pick at least one feature.' };
  return {
    features,
    layer: pick(form.layer, ['L1', 'L2'] as const, 'L1'),
    mode: pick(form.mode, ['text', 'voice'] as const, 'text'),
    design: pick(form.design, ['entoli', 'theirs', 'generate'] as const, 'entoli'),
    settingsBy: pick(form.settingsBy, ['anyone', 'admins', 'nobody'] as const, 'admins'),
    confirm: pick(form.confirm, ['contract', 'always'] as const, 'contract'),
  };
}

// ---- repository access -----------------------------------------------------------

export type RepoFiles = { exists(path: string): Promise<boolean>; read(path: string): Promise<string | null> };

export function dirFiles(root: string): RepoFiles {
  const safe = (p: string) => {
    const n = posix.normalize(p);
    if (n.startsWith('..') || posix.isAbsolute(n)) throw new Error(`unsafe path ${p}`);
    return join(root, n);
  };
  return {
    async exists(p) { try { await readFile(safe(p)); return true; } catch { return false; } },
    async read(p) { try { return await readFile(safe(p), 'utf8'); } catch { return null; } },
  };
}

/** Git's blob id, to detect a file that changed on GitHub since we read it. */
export function blobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// ---- deterministic changes ---------------------------------------------------------

export function skillForAnswers(skill: Skill, a: Answers): Skill {
  const keep = new Set(a.features.filter((f) => {
    const act = skill.acts.find((x) => x.name === f);
    if (!act) return false;
    if (act.kind === 'setting' && (a.layer === 'L1' || a.settingsBy === 'nobody')) return false;
    return true;
  }));
  return {
    ...skill,
    layer: a.layer,
    mode: a.mode,
    acts: skill.acts.filter((x) => keep.has(x.name)),
    map: skill.map.map((n) => (n.act && !keep.has(n.act) ? (({ act: _drop, ...rest }) => rest)(n) : n)),
    knowledge: skill.knowledge,
  };
}

type Layout = { kind: 'vite' | 'next'; entry: string; pkgDir: string; srcDir: string };

const VITE_ENTRIES = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js'];
const NEXT_LAYOUTS = ['app/layout.tsx', 'src/app/layout.tsx', 'app/layout.jsx', 'src/app/layout.jsx'];

/** Finds the app's entry, looking at the repo root and at the package that owns the analyzed files. */
export async function detectLayout(files: RepoFiles, hintFile?: string): Promise<Layout | null> {
  const dirs = [''];
  if (hintFile) {
    const parts = hintFile.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const d = parts.slice(0, i).join('/');
      if (await files.exists(`${d}/package.json`)) { dirs.unshift(d); break; }
    }
  }
  for (const d of dirs) {
    const at = (p: string) => (d ? `${d}/${p}` : p);
    for (const l of NEXT_LAYOUTS) if (await files.exists(at(l))) return { kind: 'next', entry: at(l), pkgDir: d, srcDir: at(l.startsWith('src/') ? 'src' : '') };
    for (const e of VITE_ENTRIES) if (await files.exists(at(e))) return { kind: 'vite', entry: at(e), pkgDir: d, srcDir: at('src') };
  }
  return null;
}

const rel = (fromDir: string, to: string) => {
  const r = posix.relative(fromDir || '.', to);
  return r.startsWith('.') ? r : `./${r}`;
};

function bootstrapVite(l: Layout, a: Answers, skillPath: string, themePath: string | null): { path: string; content: string } {
  const path = posix.join(l.srcDir, 'entoli.ts');
  const dir = posix.dirname(path);
  return {
    path,
    content: `// Entoli: makes this app operable by intent (typed${a.mode === 'voice' ? ' or spoken' : ''}).
// Acts are wired next to the code they run, with useEntoli. See entoli.skill.json.
import { mount } from '@entoli/sdk';
import skill from '${rel(dir, skillPath)}';
${themePath ? `import '${rel(dir, themePath)}';\n` : ''}
const el = document.createElement('div');
el.id = 'entoli';
document.body.append(el);

export const entoli = mount({
  el,
  skill,
  mode: '${a.mode}',
  confirm: '${a.confirm}',
  ${a.design === 'entoli' ? '' : 'fonts: false,\n  '}// Public app key from the Entoli dashboard (Keys). Optional: without it everything resolves on the device.
  key: import.meta.env.VITE_ENTOLI_KEY,
});
`,
  };
}

function bootstrapNext(l: Layout, a: Answers, skillPath: string, themePath: string | null): { path: string; content: string } {
  const path = posix.join(l.pkgDir, l.srcDir.endsWith('src') ? 'src/components/EntoliBar.tsx' : 'components/EntoliBar.tsx');
  const dir = posix.dirname(path);
  return {
    path,
    content: `'use client';
// Entoli: makes this app operable by intent (typed${a.mode === 'voice' ? ' or spoken' : ''}).
import { mount } from '@entoli/sdk';
import { useEffect, useRef } from 'react';
import skill from '${rel(dir, skillPath)}';
${themePath ? `import '${rel(dir, themePath)}';\n` : ''}
export function EntoliBar() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const entoli = mount({
      el: ref.current,
      skill,
      mode: '${a.mode}',
      confirm: '${a.confirm}',
      ${a.design === 'entoli' ? '' : 'fonts: false,\n      '}key: process.env.NEXT_PUBLIC_ENTOLI_KEY,
    });
    return () => entoli.unmount();
  }, []);
  return <div ref={ref} style={{ position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 50, display: 'flex', justifyContent: 'center' }} />;
}
`,
  };
}

/** Theme overrides for the Stage. 'theirs' inherits; 'generate' maps the app's own CSS variables. */
export function themeCss(design: Answers['design'], appCss: string | null): string | null {
  if (design === 'entoli') return null;
  const head = '/* Entoli theme: the bar and the card follow this app. Edit freely. */\n';
  if (design === 'theirs' || !appCss) {
    return `${head}.entoli { --e-ink: currentColor; --e-paper: Canvas; font-family: inherit; }\n.entoli-title, .entoli-kicker, .entoli-args code { font-family: inherit; }\n`;
  }
  const vars = [...appCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => ({ name: m[1]!, value: m[2]!.trim() }));
  const find = (re: RegExp) => vars.find((v) => re.test(v.name))?.name;
  const fg = find(/(^--(fg|foreground|text|ink)$)|text-?(primary|color)|foreground/i);
  const bg = find(/(^--(bg|background|paper|surface)$)|background|surface/i);
  const accent = find(/accent|primary|brand/i);
  const font = find(/font-?(sans|body|family)/i);
  const lines = [
    fg ? `--e-ink: var(${fg});` : '--e-ink: currentColor;',
    bg ? `--e-paper: var(${bg});` : '--e-paper: Canvas;',
    accent ? `--e-lime: var(${accent});` : '',
    accent ? `--e-lime-text: var(${accent});` : '',
    font ? `font-family: var(${font});` : 'font-family: inherit;',
  ].filter(Boolean);
  return `${head}/* Generated from this app's CSS variables. */\n.entoli { ${lines.join(' ')} }\n.entoli-title, .entoli-kicker, .entoli-args code { font-family: inherit; }\n`;
}

export function withDependency(pkgJson: string): string | null {
  let pkg: { dependencies?: Record<string, string> };
  try { pkg = JSON.parse(pkgJson) as typeof pkg; } catch { return null; }
  if (pkg.dependencies?.['@entoli/sdk']) return pkgJson;
  const indent = /\n(\s+)"/.exec(pkgJson)?.[1] ?? '  ';
  pkg.dependencies = { ...(pkg.dependencies ?? {}), '@entoli/sdk': '^0.1.0' };
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([x], [y]) => x.localeCompare(y)));
  return `${JSON.stringify(pkg, null, indent)}\n`;
}

function addImportFirst(source: string, line: string): string {
  if (source.includes(line)) return source;
  const directive = /^(['"]use (client|server)['"];?\s*\n)/.exec(source);
  return directive ? `${directive[1]}${line}\n${source.slice(directive[1]!.length)}` : `${line}\n${source}`;
}

export function syntaxErrors(path: string, content: string): string[] {
  if (!/\.(tsx?|jsx?|mjs)$/.test(path)) return [];
  const out = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).slice(0, 5);
}

// ---- Claude: wire the acts in a component file ------------------------------------

export type Editor = (input: { path: string; content: string; acts: Skill['acts']; answers: Answers; sources: { name: string; line: number; component?: string; handler?: string }[] }) => Promise<{ content: string; summary: string }>;

const EDIT_SYSTEM = `You integrate Entoli into an existing React component file. Entoli makes an app operable by intent: each declared act is wired to the app's real function with the useEntoli hook.

  import { useEntoli } from '@entoli/sdk/react';
  useEntoli(actName, slots, handler, options)
    slots: { [slotName]: 'freeText' | 'choice' | 'quantity' | 'when' | 'person' } or { type, options } for runtime choices
    handler: (slots) => result   — call the component's EXISTING function; return what undo needs
    options: { undo?: (result, slots) => void, radius?, exact?, voiceOnly? }

Rules:
- Add one useEntoli call per act, inside the component that owns the handler, after the state it uses. Do not change existing behaviour, formatting or other code.
- Only declare undo when the component can genuinely reverse the action with existing state or functions.
- quantity slots arrive as { n, label }; when slots as { at, label }; freeText and choice as strings.
- Apply the settings policy you are given: for "admins", guard settings acts with the app's existing admin check if one is visible, otherwise throw an Error('Only admins can change this'); for "anyone", no guard.
- Return the complete new file content.`;

export const claudeEditor: Editor = async ({ path, content, acts, answers, sources }) => {
  const r = await askJson<{ content: string; summary: string }>({
    system: EDIT_SYSTEM,
    prompt: `File: ${path}\nSettings policy: ${answers.settingsBy}\nActs to wire (from entoli.skill.json):\n${JSON.stringify(acts, null, 1)}\nWhere they are in this file:\n${JSON.stringify(sources)}\n\nCurrent file:\n\`\`\`\n${content}\n\`\`\``,
    schema: { type: 'object', additionalProperties: false, required: ['content', 'summary'], properties: { content: { type: 'string' }, summary: { type: 'string' } } },
    effort: 'medium',
    maxTokens: 32000,
  });
  return r.data;
};

// ---- generation -------------------------------------------------------------------------

const MAX_EDIT_BYTES = 80_000;

export async function latestSources(db: DB, appId: string) {
  const [a] = await db.select({ sources: analyses.sources }).from(analyses).where(and(eq(analyses.appId, appId), eq(analyses.status, 'done'))).orderBy(desc(analyses.createdAt)).limit(1);
  return a?.sources ?? {};
}

type AppRow = { id: string; plan: keyof typeof PLANS; skill: unknown; repo: string | null; installationId: string | null };

export function integrationAllowed(app: AppRow): string | null {
  if (!PLANS[app.plan].integration) return 'Integration (by voice, or by answering a few questions) is part of the L2 plan. On L1, export the skill to your coding agent instead (Skill tab).';
  if (!app.repo) return 'Connect a repository first.';
  return null;
}

export async function startIntegration(db: DB, app: AppRow, answers: Answers) {
  const [row] = await db.insert(integrations).values({ appId: app.id, answers, status: 'interview' }).returning();
  return row!;
}

export async function generateIntegration(db: DB, app: AppRow, integrationId: string, deps: { files: RepoFiles; edit?: Editor; modelAvailable?: boolean }): Promise<void> {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw new Error('integration not found');
  const answers = row.answers as Answers;
  const changes: IntegrationChange[] = [];
  const notes: string[] = [];
  const add = (title: string, path: string, before: string | null, after: string, extra: Partial<IntegrationChange> = {}) => {
    if (before === after) return;
    changes.push({
      id: randomUUID().slice(0, 8), title, file: path, content: after, status: 'pending',
      diff: createTwoFilesPatch(before === null ? '/dev/null' : `a/${path}`, `b/${path}`, before ?? '', after, '', '', { context: 3 }),
      baseSha: before !== null ? blobSha(before) : null,
      ...extra,
    });
  };
  try {
    await db.update(integrations).set({ status: 'generating', error: null }).where(eq(integrations.id, integrationId));
    const full = skillOf(app);
    if (!full) throw new Error('This app has no valid skill yet. Analyze or write one first.');
    const skill = skillForAnswers(full, answers);
    const v = validateSkill(skill);
    if (!v.ok) throw new Error(`The selected features do not form a valid skill: ${v.errors.slice(0, 2).join('; ')}`);
    const sources = await latestSources(db, app.id);
    const firstSource = Object.values(sources).flat()[0]?.file;
    const layout = await detectLayout(deps.files, firstSource);
    if (!layout) throw new Error('Could not find the app entry (src/main.tsx, src/index.tsx or app/layout.tsx).');

    // 1. The skill, next to the app's package.json.
    const skillPath = posix.join(layout.pkgDir, 'entoli.skill.json');
    add('Add entoli.skill.json', skillPath, await deps.files.read(skillPath), `${JSON.stringify(skill, null, 2)}\n`);

    // 2. The dependency.
    const pkgPath = posix.join(layout.pkgDir, 'package.json');
    const pkgBefore = await deps.files.read(pkgPath);
    const pkgAfter = pkgBefore ? withDependency(pkgBefore) : null;
    if (pkgBefore && pkgAfter) add('Add @entoli/sdk to dependencies', pkgPath, pkgBefore, pkgAfter);

    // 3. Theme.
    let themePath: string | null = null;
    const appCssPath = ['src/index.css', 'src/styles.css', 'src/App.css', 'app/globals.css', 'src/app/globals.css', 'styles/globals.css'].map((p) => posix.join(layout.pkgDir, p));
    let appCss: string | null = null;
    for (const p of appCssPath) { appCss = await deps.files.read(p); if (appCss) break; }
    const css = themeCss(answers.design, appCss);
    if (css) {
      themePath = posix.join(layout.srcDir || layout.pkgDir, 'entoli.theme.css');
      add('Theme the Entoli bar to match the app', themePath, await deps.files.read(themePath), css);
    }

    // 4. Bootstrap and entry.
    const boot = layout.kind === 'vite' ? bootstrapVite(layout, answers, skillPath, themePath) : bootstrapNext(layout, answers, skillPath, themePath);
    add(`Mount Entoli (${layout.kind === 'vite' ? 'Vite / React' : 'Next.js'})`, boot.path, await deps.files.read(boot.path), boot.content);
    const entryBefore = await deps.files.read(layout.entry);
    if (entryBefore !== null) {
      let entryAfter: string;
      if (layout.kind === 'vite') entryAfter = addImportFirst(entryBefore, `import '${rel(posix.dirname(layout.entry), boot.path).replace(/\.ts$/, '')}';`);
      else {
        const withImport = addImportFirst(entryBefore, `import { EntoliBar } from '${rel(posix.dirname(layout.entry), boot.path).replace(/\.tsx$/, '')}';`);
        entryAfter = withImport.includes('<EntoliBar') ? withImport : withImport.replace(/(\s*)<\/body>/, '$1  <EntoliBar />$1</body>');
        if (!entryAfter.includes('<EntoliBar')) notes.push(`Add <EntoliBar /> to ${layout.entry} by hand: no </body> found.`);
      }
      add(`Load Entoli from ${layout.entry}`, layout.entry, entryBefore, entryAfter);
    }

    // 5. Each feature file: wire useEntoli (Claude).
    const byFile = new Map<string, { act: Skill['acts'][number]; srcs: { line: number; component?: string; handler?: string }[] }[]>();
    for (const act of skill.acts) {
      const srcs = sources[act.name] ?? [];
      if (!srcs.length) { notes.push(`${act.name}: no source location from the analysis; wire it by hand (see the README).`); continue; }
      const file = srcs[0]!.file;
      (byFile.get(file) ?? byFile.set(file, []).get(file)!).push({ act, srcs });
    }
    const modelAvailable = deps.modelAvailable ?? hasAnthropicKey();
    const edit = deps.edit ?? claudeEditor;
    for (const [file, entries] of byFile) {
      const before = await deps.files.read(file);
      if (before === null) { notes.push(`${file} no longer exists; skipped.`); continue; }
      if (Buffer.byteLength(before) > MAX_EDIT_BYTES) { notes.push(`${file} is over ${MAX_EDIT_BYTES / 1000} kB; wire its acts by hand.`); continue; }
      if (!modelAvailable) { notes.push(`${file}: wiring ${entries.map((e) => e.act.name).join(', ')} needs the model (ANTHROPIC_API_KEY).`); continue; }
      try {
        const r = await edit({ path: file, content: before, acts: entries.map((e) => e.act), answers, sources: entries.flatMap((e) => e.srcs.map((s) => ({ name: e.act.name, ...s }))) });
        const errors = syntaxErrors(file, r.content);
        if (errors.length) { notes.push(`${file}: the generated change did not parse (${errors[0]}); not offered.`); continue; }
        if (!r.content.includes('useEntoli(')) { notes.push(`${file}: the generated change wired nothing; not offered.`); continue; }
        add(`Wire ${entries.map((e) => e.act.title ?? e.act.name).join(', ')}`, file, before, r.content, { summary: r.summary });
      } catch (e) {
        notes.push(`${file}: ${(e as Error).message}`);
      }
    }
    await db.update(integrations).set({ status: 'generated', changes, error: notes.length ? notes.join('\n') : null }).where(eq(integrations.id, integrationId));
  } catch (e) {
    await db.update(integrations).set({ status: 'failed', changes, error: (e as Error).message }).where(eq(integrations.id, integrationId));
  }
}

export async function setChangeStatus(db: DB, integrationId: string, changeId: string, status: 'approved' | 'rejected' | 'pending') {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row || row.status === 'pr_opened') return;
  const changes = row.changes.map((c) => (c.id === changeId ? { ...c, status } : c));
  await db.update(integrations).set({ changes }).where(eq(integrations.id, integrationId));
}

// ---- the pull request -------------------------------------------------------------------

export type PrDeps = { fetch?: typeof fetch; token?: (installationId: string, repo: string) => Promise<string> };

export async function openPullRequest(db: DB, app: AppRow, integrationId: string, deps: PrDeps = {}): Promise<string> {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.appId, app.id)));
  if (!row) throw new Error('integration not found');
  if (row.status === 'pr_opened' && row.prUrl) return row.prUrl;
  const approved = row.changes.filter((c) => c.status === 'approved');
  if (!approved.length) throw new Error('Approve at least one change first.');
  if (!app.repo) throw new Error('No repository.');
  if (!app.installationId) throw new Error('Install the Entoli GitHub App on this repository first (Map tab).');

  let token: string;
  try {
    token = await (deps.token ?? ((id, repo) => installationToken(id, { repo, write: true })))(app.installationId, app.repo);
  } catch (e) {
    throw new Error(`GitHub did not grant write access (contents, pull requests). Approve the new permissions for the Entoli app on GitHub, then try again. (${(e as Error).message})`);
  }
  const f = deps.fetch ?? fetch;
  const api = <T>(path: string, init: RequestInit = {}) => gh<T>(path, token, init, f);
  const repo = app.repo;

  const meta = await api<{ default_branch: string }>(`/repos/${repo}`);
  const base = meta.default_branch;
  const ref = await api<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const head = ref.object.sha;
  const commit = await api<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${head}`);

  // Refuse to overwrite anything that changed on GitHub since it was read.
  for (const c of approved) {
    const current = await api<{ sha: string }>(`/repos/${repo}/contents/${c.file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(base)}`).catch(() => null);
    const expected = c.baseSha ?? null;
    if ((current?.sha ?? null) !== expected) throw new Error(`${c.file} changed on ${base} since the changes were generated. Generate again.`);
  }

  const tree = await api<{ sha: string }>(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: approved.map((c) => ({ path: c.file, mode: '100644', type: 'blob', content: c.content })) }),
  });
  const answers = row.answers as Answers;
  const message = `Integrate Entoli (${answers.layer}, ${answers.mode})\n\n${approved.map((c) => `- ${c.title}`).join('\n')}`;
  const newCommit = await api<{ sha: string }>(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head] }) });
  const branch = `entoli/integration-${integrationId.slice(0, 8)}`;
  await api(`/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }) });
  const pr = await api<{ html_url: string }>(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Make the app operable by intent with Entoli',
      head: branch,
      base,
      body: `This pull request was prepared in the Entoli dashboard. Every change below was reviewed and approved there, one by one.\n\n${approved.map((c) => `- **${c.title}** (\`${c.file}\`)`).join('\n')}\n\nAfter merging: install dependencies, add your public app key (\`VITE_ENTOLI_KEY\` or \`NEXT_PUBLIC_ENTOLI_KEY\`) from the dashboard's Keys tab, and try a phrase in the bar.\n\nThe AI only chooses among the acts declared in \`entoli.skill.json\`; small, reversible actions run after a short visible hold, everything else waits for a yes.`,
    }),
  });
  await db.update(integrations).set({ status: 'pr_opened', prUrl: pr.html_url }).where(eq(integrations.id, integrationId));
  return pr.html_url;
}
