/**
 * Projects built on Entoli: a blank start, or a copy of an existing app that is
 * rebuilt around Entoli. The files live in our database (`project_files`), not
 * in any repository, until the developer exports them.
 *
 *   blank    describe the app → Entoli writes the skill first (screens, acts,
 *            knowledge) → a tiny runnable starter shell with the bar mounted →
 *            the developer's own coding agent builds the app around it (MCP).
 *   rebuild  the original repository stays untouched (`apps.repo`) and keeps
 *            running in its own sandbox; a copy of its source becomes the new
 *            project the agent rebuilds. Both run side by side; the same map
 *            walk and phrase checks run on both.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { apps, projectFiles, sandboxes } from '@/db/schema';
import { assertSkill, validateSkill, type Skill } from '@entoli/sdk/skill';
import { askJson, hasAnthropicKey } from '@entoli/analyzer';
import { createApp, listApps, saveSkill } from './apps';
import { fetchRepo, type Fetched } from './repo-fetch';
import { normalizePath } from './guardrails';
import { PLANS } from './plans';
import { hit } from './ratelimit';

type AppRow = typeof apps.$inferSelect;

export const isProject = (app: Pick<AppRow, 'origin'>) => app.origin?.kind === 'blank' || app.origin?.kind === 'rebuild';

export const MAX_PROJECT_FILES = 300;
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const BLOCKED = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage|\.env[^/]*|\.vercel|\.turbo)(\/|$)/i;
const TEXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|html?|md|svg|txt|vue|svelte|yml|yaml)$|(^|\/)(\.gitignore|\.npmrc)$/;

// ---- the starter shell ----------------------------------------------------------------------------------------------

const SERVER = `// A dependency-free static server so the starter runs anywhere. Replace it when your agent adds a framework.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\\\]*\\.\\.)+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(process.cwd(), p));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, process.env.HOST || '127.0.0.1');
`;

const html = (name: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name.replace(/[<>&"]/g, '')}</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body>
    <main id="app"></main>
    <div id="entoli"></div>
    <script src="./entoli.min.js"></script>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`;

const CSS = `body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #1b1b1f; background: #fff; }
main { max-width: 720px; margin: 0 auto; padding: 32px 16px 120px; }
section[data-screen] { border: 1px solid #e2e2e8; border-radius: 12px; padding: 16px; margin: 0 0 16px; }
section[data-screen] h2 { margin: 0 0 8px; font-size: 1.1rem; }
.todo { color: #6b6b76; font-size: .9rem; }
`;

const APP_JS = `// Starter shell. Each screen from entoli.skill.json is a section; each act is registered as a placeholder.
// Your coding agent replaces the placeholders with the real feature (see get_instructions over MCP).
const skill = await (await fetch('./entoli.skill.json')).json();
const app = document.getElementById('app');
for (const node of skill.map) {
  const s = document.createElement('section');
  s.setAttribute('data-screen', node.id);
  s.innerHTML = '<h2></h2><p class="todo">Not built yet.</p>';
  s.querySelector('h2').textContent = node.title;
  app.append(s);
}
const entoli = Entoli.mount({ el: '#entoli', skill });
for (const act of skill.acts) {
  entoli.register(act.name, {}, async () => ({ built: false }), { say: () => act.title + ' is not built yet.', describe: () => act.title });
}
`;

export type Template = 'static' | 'vite' | 'next';
export const TEMPLATES: { id: Template; label: string; note: string }[] = [
  { id: 'static', label: 'Plain HTML and JavaScript', note: 'No install step: starts at once.' },
  { id: 'vite', label: 'Vite + React', note: 'npm install, then a dev server.' },
  { id: 'next', label: 'Next.js', note: 'npm install, then a dev server (slower first start).' },
];

// The same behaviour in each framework: one section per screen, every act a placeholder until the agent builds it.
const REACT_BODY = (skillUrl: string) => `  const [skill, setSkill] = useState(null);
  useEffect(() => { fetch('${skillUrl}').then((r) => r.json()).then(setSkill); }, []);
  useEffect(() => {
    if (!skill || !window.Entoli) return;
    const bar = window.Entoli.mount({ el: '#entoli', skill, fonts: false });
    for (const act of skill.acts) bar.register(act.name, {}, async () => ({ built: false }), { say: () => act.title + ' is not built yet.', describe: () => act.title });
    return () => { document.getElementById('entoli').replaceChildren(); };
  }, [skill]);
  return (
    <main>
      {(skill?.map ?? []).map((n) => (
        <section key={n.id} data-screen={n.id}>
          <h2>{n.title}</h2>
          <p className="todo">Not built yet.</p>
        </section>
      ))}
      <div id="entoli" />
    </main>
  );`;

export function scaffold(name: string, skill: Skill, sdkBundle: string, template: Template = 'static'): { path: string; content: string }[] {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  const skillJson = JSON.stringify(skill, null, 2) + '\n';
  if (template === 'vite') {
    return [
      { path: 'package.json', content: JSON.stringify({ name: slug, private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^5.4.11' } }, null, 2) + '\n' },
      { path: 'vite.config.js', content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n" },
      { path: 'index.html', content: `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${name.replace(/[<>&"]/g, '')}</title></head>\n  <body>\n    <div id="root"></div>\n    <script src="/entoli.min.js"></script>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n` },
      { path: 'src/main.jsx', content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './app.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n" },
      { path: 'src/App.jsx', content: `import { useEffect, useState } from 'react';\n\n// Starter. Your coding agent replaces the placeholders with the real features (get_instructions over MCP).\nexport default function App() {\n${REACT_BODY('/entoli.skill.json')}\n}\n` },
      { path: 'src/app.css', content: CSS },
      { path: 'public/entoli.min.js', content: sdkBundle },
      { path: 'public/entoli.skill.json', content: skillJson },
      { path: 'entoli.skill.json', content: skillJson },
    ];
  }
  if (template === 'next') {
    return [
      { path: 'package.json', content: JSON.stringify({ name: slug, private: true, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '^15.1.0', react: '^19.0.0', 'react-dom': '^19.0.0' } }, null, 2) + '\n' },
      { path: 'next.config.js', content: "// The sandbox opens the dev server on its own host names.\nmodule.exports = { allowedDevOrigins: ['127.0.0.1', 'localhost', '*.vercel.run', '*.vercel.app'] };\n" },
      { path: 'app/layout.js', content: `import Script from 'next/script';\nimport './globals.css';\n\nexport const metadata = { title: ${JSON.stringify(name)} };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script src="/entoli.min.js" strategy="beforeInteractive" />\n      </body>\n    </html>\n  );\n}\n` },
      { path: 'app/page.js', content: `'use client';\nimport { useEffect, useState } from 'react';\n\n// Starter. Your coding agent replaces the placeholders with the real features (get_instructions over MCP).\nexport default function Page() {\n${REACT_BODY('/entoli.skill.json')}\n}\n` },
      { path: 'app/globals.css', content: CSS },
      { path: 'public/entoli.min.js', content: sdkBundle },
      { path: 'public/entoli.skill.json', content: skillJson },
      { path: 'entoli.skill.json', content: skillJson },
    ];
  }
  return [
    { path: 'package.json', content: JSON.stringify({ name: slug, private: true, type: 'module', scripts: { dev: 'node server.mjs', start: 'node server.mjs' } }, null, 2) + '\n' },
    { path: 'server.mjs', content: SERVER },
    { path: 'index.html', content: html(name) },
    { path: 'app.css', content: CSS },
    { path: 'app.js', content: APP_JS },
    { path: 'entoli.min.js', content: sdkBundle },
    { path: 'entoli.skill.json', content: skillJson },
  ];
}

async function sdkBundle(): Promise<string> {
  for (const p of [join(process.cwd(), 'public/entoli.min.js'), join(process.cwd(), 'apps/web/public/entoli.min.js')]) {
    try { return await readFile(p, 'utf8'); } catch { /* try the next */ }
  }
  // On a serverless deployment the public folder is served over HTTP but is not on disk.
  const base = process.env.APP_URL?.replace(/\/$/, '');
  if (base) {
    const r = await fetch(`${base}/entoli.min.js`).catch(() => null);
    if (r?.ok) return r.text();
  }
  throw new Error('The Entoli SDK bundle (public/entoli.min.js) is missing from this deployment.');
}

// ---- blank: the skill first ---------------------------------------------------------------------------------------------

/** What the model is asked for: the same skill format, written from the description. */
const DRAFT_SYSTEM = `You write the Entoli skill for an app that does not exist yet, from the developer's description. The skill is the app's contract: its screens (map), what it can answer (knowledge) and the things a person can ask it to do (acts). Rules: 3 to 8 screens, each {id, kind:"screen", title, path:"/", selector:"[data-screen=<id>]"}; each act {name (lowercase, dotted, e.g. "task.add"), title, screen (a screen id), phrases (2-5 natural phrases), radius ("self" | "other-person" | "external"), undo (true when it can be undone), slots (only types choice, quantity, when, person, freeText)}; set "kind":"setting" for acts that change how the app behaves. Prefer undoable acts. Anything that pays, deletes for good or contacts someone outside the app has radius "external" or no undo. 4 to 12 acts. 2 to 6 knowledge items {topic, can (boolean), answer, phrases}, including honest "no" answers for things the app will not do. Top-level: {"entoli":"0.1","app":{"name","description"},"layer":"L1","mode":"text","map":[],"knowledge":[],"acts":[]}. Output only that JSON object.`;

export type SkillDrafter = (input: { name: string; description: string }) => Promise<unknown>;

export const claudeDrafter: SkillDrafter = async ({ name, description }) => {
  const r = await askJson<unknown>({ system: DRAFT_SYSTEM, prompt: `App name: ${name}\nDescription: ${description}`, schema: { type: 'object' }, effort: 'medium', maxTokens: 8000 });
  return r.data;
};

/** An empty but valid skill: used when there is no model to draft one. The developer (or their agent) adds acts. */
export function emptySkill(name: string, description: string): Skill {
  return assertSkill({ entoli: '0.1', app: { name, description }, layer: 'L1', mode: 'text', map: [{ id: 'home', kind: 'screen', title: 'Home', path: '/', selector: '[data-screen=home]' }], knowledge: [], acts: [] });
}

async function draftSkill(name: string, description: string, drafter?: SkillDrafter): Promise<{ skill: Skill; drafted: boolean; note?: string }> {
  const draft = drafter ?? (hasAnthropicKey() ? claudeDrafter : null);
  if (!draft) return { skill: emptySkill(name, description), drafted: false, note: 'No model is configured, so the skill starts with one empty screen. Add features in the Map tab or ask your agent.' };
  let last = '';
  for (let i = 0; i < 2; i++) {
    const raw = await draft({ name, description: i ? `${description}\n\nYour previous attempt was invalid: ${last}` : description });
    const v = validateSkill(raw);
    if (v.ok) return { skill: { ...(raw as Skill), app: { ...(raw as Skill).app, name } }, drafted: true };
    last = v.errors.slice(0, 5).join('; ');
  }
  return { skill: emptySkill(name, description), drafted: false, note: `The draft was not a valid skill (${last}). Started empty instead.` };
}

// ---- files ------------------------------------------------------------------------------------------------------------------

export async function projectFilesOf(db: DB, appId: string) {
  return db.select().from(projectFiles).where(eq(projectFiles.appId, appId)).orderBy(asc(projectFiles.path));
}

export async function readProjectFile(db: DB, appId: string, path: string): Promise<string | null> {
  const [r] = await db.select({ content: projectFiles.content }).from(projectFiles).where(and(eq(projectFiles.appId, appId), eq(projectFiles.path, path)));
  return r?.content ?? null;
}

export async function writeProjectFile(db: DB, appId: string, rawPath: string, content: string): Promise<void> {
  const path = normalizePath(rawPath);
  if (!path || BLOCKED.test(path)) throw new Error(`"${rawPath}" is not a file a project may hold.`);
  const existing = await projectFilesOf(db, appId);
  const others = existing.filter((f) => f.path !== path);
  if (others.length >= MAX_PROJECT_FILES) throw new Error(`A project holds at most ${MAX_PROJECT_FILES} files.`);
  if (others.reduce((n, f) => n + f.content.length, 0) + content.length > MAX_PROJECT_BYTES) throw new Error('The project is over its size limit.');
  await db.insert(projectFiles).values({ appId, path, content }).onConflictDoUpdate({ target: [projectFiles.appId, projectFiles.path], set: { content, updatedAt: new Date() } });
}

export async function deleteProjectFile(db: DB, appId: string, path: string): Promise<void> {
  await db.delete(projectFiles).where(and(eq(projectFiles.appId, appId), eq(projectFiles.path, path)));
}

// ---- starting -------------------------------------------------------------------------------------------------------------------

/** A short name from a description: "a todo list with a done screen" → "Todo List". */
export function nameFromDescription(description: string): string {
  const words = description.replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !/^(a|an|the|my|i|me|build|make|create|app|simple|new|that|which|with|for|and|to|of)$/i.test(w)).slice(0, 3);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'New app';
}

export async function startBlank(db: DB, ownerId: string, input: { name: string; description: string; template?: Template }, deps: { drafter?: SkillDrafter; bundle?: string } = {}) {
  const description = input.description.trim().slice(0, 2000);
  if (!description) throw new Error('Describe the app you want to build, in a sentence or two.');
  // Drafting costs money: more for people who pay.
  const paid = (await listApps(db, ownerId)).some((a) => PLANS[a.plan].priceUsd > 0);
  const perDay = paid ? 10 : 2;
  if (!(await hit(db, `blank:${ownerId}`, perDay, 86_400_000)).ok) throw new Error(`${perDay} new projects a day at most${paid ? '' : ' on the free plan'}. Try again tomorrow.`);
  const { app } = await createApp(db, ownerId, { name: input.name });
  await db.update(apps).set({ origin: { kind: 'blank', description, template: input.template ?? 'static' } }).where(eq(apps.id, app.id));
  const { skill, drafted, note } = await draftSkill(app.name, description, deps.drafter);
  const saved = await saveSkill(db, ownerId, app.id, skill, 'draft');
  if (!saved.ok) throw new Error(saved.errors.join(' '));
  const bundle = deps.bundle ?? (await sdkBundle());
  for (const f of scaffold(app.name, skill, bundle, input.template ?? 'static')) await writeProjectFile(db, app.id, f.path, f.content);
  return { appId: app.id, drafted, ...(note ? { note } : {}), files: (await projectFilesOf(db, app.id)).length };
}

/** The folder an app lives in: the repository root, or a folder inside it (a monorepo's app). Never outside the checkout. */
export async function appRoot(dir: string, subdir: string | null | undefined): Promise<string> {
  if (!subdir) return dir;
  const { stat, realpath } = await import('node:fs/promises');
  const want = join(dir, subdir);
  const [real, base] = await Promise.all([realpath(want).catch(() => null), realpath(dir)]);
  if (!real || !real.startsWith(base) || !(await stat(real)).isDirectory()) throw new Error(`The folder "${subdir}" does not exist in the repository.`);
  return real;
}

/** Source files (text, within limits) from a fetched repository. */
async function readSource(f: Fetched): Promise<{ path: string; content: string }[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const out: { path: string; content: string }[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      if (BLOCKED.test(r)) continue;
      const p = join(dir, name);
      const st = await stat(p);
      if (st.isDirectory()) { await walk(p, r); continue; }
      if (!st.isFile() || !TEXT.test(r) || st.size > 400_000) continue;
      total += st.size;
      if (out.length >= MAX_PROJECT_FILES || total > MAX_PROJECT_BYTES) throw new Error(`The original is too large to copy (over ${MAX_PROJECT_FILES} text files or ${MAX_PROJECT_BYTES / 1e6} MB). Rebuild a smaller app, or start blank.`);
      out.push({ path: r, content: await readFile(p, 'utf8') });
    }
  };
  await walk(f.dir, '');
  return out;
}

export async function startRebuild(db: DB, ownerId: string, input: { name: string; repo: string; subdir?: string | null }, deps: { source?: (repo: string) => Promise<Fetched> } = {}) {
  // Copying downloads a whole repository: limit it per person, more for people who pay.
  const paid = (await listApps(db, ownerId)).some((a) => PLANS[a.plan].priceUsd > 0);
  const perDay = paid ? 20 : 3;
  if (!(await hit(db, `rebuild:${ownerId}`, perDay, 86_400_000)).ok) throw new Error(`${perDay} copies a day at most${paid ? '' : ' on the free plan'}. Try again tomorrow.`);
  const { app } = await createApp(db, ownerId, { name: input.name, repo: input.repo, subdir: input.subdir ?? null });
  if (!app.repo) throw new Error('Choose the original repository to rebuild.');
  await db.update(apps).set({ origin: { kind: 'rebuild' } }).where(eq(apps.id, app.id));
  let fetched: Fetched | null = null;
  try {
    fetched = await (deps.source ?? ((r) => fetchRepo(r, { all: true })))(app.repo);
    const root = await appRoot(fetched.dir, app.subdir);
    const files = await readSource({ ...fetched, dir: root });
    if (!files.some((f) => f.path === 'package.json')) throw new Error(`The original has no package.json ${app.subdir ? `in ${app.subdir}` : 'at its root'}, so it cannot be copied into a project.`);
    for (const f of files) await writeProjectFile(db, app.id, f.path, f.content);
    return { appId: app.id, files: files.length };
  } catch (e) {
    await db.delete(apps).where(eq(apps.id, app.id));
    throw e;
  } finally {
    await fetched?.cleanup().catch(() => {});
  }
}

// ---- export -----------------------------------------------------------------------------------------------------------------------

export async function exportZip(db: DB, appId: string): Promise<Uint8Array> {
  const files = await projectFilesOf(db, appId);
  if (!files.length) throw new Error('This project has no files yet.');
  return zipSync(Object.fromEntries(files.map((f) => [f.path, strToU8(f.content)])));
}

// ---- compare ----------------------------------------------------------------------------------------------------------------------

export type Side = { role: 'new' | 'original'; sandboxId: string | null; status: string; url: string | null; walkCoverage: number | null; phrasePercent: number | null; broken: number; checkedAt: string | null; error: string | null };
export type Comparison = { original: Side; rebuilt: Side; verdict: string };

const side = (role: Side['role'], r: typeof sandboxes.$inferSelect | undefined): Side => {
  const c = r?.results as { at: string; walk: { coverage: number; broken: unknown[] } | null; summary: { percent: number } } | null | undefined;
  return { role, sandboxId: r?.id ?? null, status: r?.status ?? 'none', url: r?.status === 'ready' ? r.url : null, walkCoverage: c?.walk?.coverage ?? null, phrasePercent: c?.summary?.percent ?? null, broken: c?.walk?.broken.length ?? 0, checkedAt: c?.at ?? null, error: r?.status === 'failed' ? (r.error ?? 'failed') : null };
};

/** The latest sandbox of each role and what the same checks found on both. Both sides are judged by the same map and the same phrases. */
export async function compare(db: DB, app: AppRow): Promise<Comparison> {
  const rows = await db.select().from(sandboxes).where(eq(sandboxes.appId, app.id)).orderBy(desc(sandboxes.createdAt));
  const original = side('original', rows.find((r) => r.role === 'original'));
  const rebuilt = side('new', rows.find((r) => r.role === 'new'));
  const pct = (n: number | null) => (n === null ? 'not checked' : `${Math.round(n)}%`);
  let verdict: string;
  if (rebuilt.walkCoverage === null) verdict = 'Run the checks on the new app first.';
  else if (original.walkCoverage === null) verdict = `The new app's map walk covers ${pct(rebuilt.walkCoverage)}. Run the original too, to compare.`;
  else if (rebuilt.walkCoverage >= original.walkCoverage) verdict = `The new app reaches as many screens as the original (${pct(rebuilt.walkCoverage)} against ${pct(original.walkCoverage)}).`;
  else verdict = `The new app reaches fewer screens than the original (${pct(rebuilt.walkCoverage)} against ${pct(original.walkCoverage)}). The original is kept: nothing is lost.`;
  return { original, rebuilt, verdict };
}

export const projectAllowed = (app: AppRow): string | null => (PLANS[app.plan].integration ? null : 'Starting a project by voice or description is part of the L2 plan.');
