/**
 * "What is this app, and how do I make it operable by intent?"
 *
 * Reads a repository and says, from evidence in the files (never a guess from
 * the name): what kind of app it is, how it is built and started, where the
 * Entoli bar should be mounted, how each feature should be wired in THAT
 * framework's idiom, and how much of this Entoli can do for it automatically.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { analyze, type AnalyzeOptions, type AnalyzeResult } from './index.js';

export type AppKind =
  | 'nextjs' | 'nuxt' | 'sveltekit' | 'remix' | 'astro'
  | 'react' | 'preact' | 'solid' | 'vue' | 'vue2' | 'svelte' | 'angular' | 'lit' | 'qwik' | 'ember'
  | 'jquery' | 'backbone' | 'alpine' | 'htmx' | 'vanilla'
  | 'angularjs' | 'knockout' | 'polymer' | 'mithril' | 'ractive' | 'canjs' | 'dojo' | 'yui' | 'extjs' | 'closure' | 'gwt' | 'dart' | 'meteor'
  | 'react-native' | 'electron' | 'node-server' | 'unknown';

/** How much Entoli can do without a person: `full` reads the code and wires it with hooks; `partial` reads markup and wires with defineAct; `manual` means the page can host the bar but the features must be named by hand or by a model; `none` means the app is not a web UI. */
export type Support = 'full' | 'partial' | 'manual' | 'none';

export type Profile = {
  kind: AppKind;
  /** Human name, e.g. "Next.js (App Router)". */
  label: string;
  language: 'typescript' | 'javascript';
  bundler: string;
  packageManager: string;
  /** Start command, when one is declared. */
  dev: string | null;
  /** The file where the bar should be mounted. */
  entry: string | null;
  /** The HTML page the bar's container goes in, when there is one. */
  page: string | null;
  evidence: string[];
  support: Support;
};

export type Plan = {
  profile: Profile;
  /** What the static scan found. */
  found: { screens: number; controls: number; acts: { name: string; title: string; where: string }[] };
  /** Ordered steps, concrete for this app. */
  steps: { title: string; detail: string; code?: string }[];
  /** Things to know before relying on it. */
  caveats: string[];
};

type Pkg = { name?: string; main?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'coverage', 'bower_components', '.cache']);

function walkFiles(root: string, limit = 4000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) {
      if (n.startsWith('.') && n !== '.') continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!SKIP.has(n)) stack.push(p); } else out.push(p);
    }
  }
  return out;
}

const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

export function inspectRepo(rootIn: string): Profile {
  const root = resolve(rootIn);
  const rel = (p: string) => relative(root, p).split(sep).join('/');
  const files = walkFiles(root);
  const has = (re: RegExp) => files.some((f) => re.test(rel(f)));
  let pkg: Pkg = {};
  try { pkg = JSON.parse(read(join(root, 'package.json'))) as Pkg; } catch { /* no package.json */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dep = (n: string) => n in deps;
  const evidence: string[] = [];
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const html = htmlFiles.slice(0, 6).map(read).join('\n');
  const pageScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase());
  const script = (re: RegExp) => pageScripts.some((s) => re.test(s)) || dep(re.source);

  const lang: Profile['language'] = existsSync(join(root, 'tsconfig.json')) || has(/\.tsx?$/) ? 'typescript' : 'javascript';
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lockb')) ? 'bun' : existsSync(join(root, 'package-lock.json')) ? 'npm' : pkg.name ? 'npm' : 'none';
  const bundler = dep('next') ? 'next' : dep('nuxt') ? 'nuxt' : dep('vite') || has(/(^|\/)vite\.config\./) ? 'vite' : dep('react-scripts') ? 'create-react-app (webpack)' : dep('webpack') || has(/webpack\.config\./) ? 'webpack' : dep('parcel') ? 'parcel' : dep('esbuild') ? 'esbuild' : dep('@angular/cli') ? 'angular cli' : dep('gulp') ? 'gulp' : dep('grunt') ? 'grunt' : 'none (files served as they are)';
  const dev = pkg.scripts?.dev ? `${pm === 'none' ? 'npm' : pm} run dev` : pkg.scripts?.start ? `${pm === 'none' ? 'npm' : pm} start` : null;

  let kind = 'unknown' as AppKind;
  let label = 'Unknown';
  const say = (k: AppKind, l: string, why: string) => { kind = k; label = l; evidence.push(why); };

  if (dep('react-native') || dep('expo')) say('react-native', 'React Native / Expo (native, not a web UI)', `package.json depends on ${dep('expo') ? 'expo' : 'react-native'}`);
  else if (dep('electron')) say('electron', 'Electron desktop app', 'package.json depends on electron');
  else if (dep('next')) say('nextjs', has(/(^|\/)app\/(layout|page)\.[jt]sx?$/) ? 'Next.js (App Router)' : 'Next.js (Pages Router)', `package.json depends on next ${deps.next}`);
  else if (dep('nuxt')) say('nuxt', 'Nuxt (Vue)', 'package.json depends on nuxt');
  else if (dep('@sveltejs/kit')) say('sveltekit', 'SvelteKit', 'package.json depends on @sveltejs/kit');
  else if (dep('@remix-run/react') || dep('@remix-run/node')) say('remix', 'Remix (React)', 'package.json depends on @remix-run');
  else if (dep('astro')) say('astro', 'Astro', 'package.json depends on astro');
  else if (dep('@angular/core')) say('angular', 'Angular', 'package.json depends on @angular/core');
  else if (dep('solid-js')) say('solid', 'SolidJS', 'package.json depends on solid-js');
  else if (dep('preact') && !dep('react')) say('preact', 'Preact', 'package.json depends on preact');
  else if (dep('lit') || dep('lit-element')) say('lit', 'Lit (web components)', 'package.json depends on lit');
  else if (dep('@builder.io/qwik')) say('qwik', 'Qwik', 'package.json depends on @builder.io/qwik');
  else if (dep('ember-source')) say('ember', 'Ember', 'package.json depends on ember-source');
  else if (dep('svelte') || has(/\.svelte$/)) say('svelte', 'Svelte', dep('svelte') ? 'package.json depends on svelte' : 'contains .svelte files');
  else if (dep('vue')) { const v = /\d+/.exec(String(deps.vue))?.[0]; say(v === '2' ? 'vue2' : 'vue', v === '2' ? 'Vue 2' : 'Vue 3', `package.json depends on vue ${deps.vue}`); }
  else if (dep('react') || has(/\.[jt]sx$/)) say('react', dep('react-scripts') ? 'React (Create React App)' : dep('vite') ? 'React (Vite)' : 'React', dep('react') ? 'package.json depends on react' : 'contains .jsx/.tsx files');
  else if (has(/\.vue$/)) say('vue', 'Vue', 'contains .vue files');
  else if (script(/vue(\.min)?\.js|vue@|unpkg\.com\/vue/)) say('vue2', 'Vue (loaded from a script tag)', 'the page loads vue from a script tag');
  else {
    // Libraries loaded from script tags or recognisable by their markup. Most specific first: a TodoMVC-style page
    // loads jQuery AND the framework, and the framework is what the app is.
    const names = files.map(rel).join('\n');
    const LIBS: [AppKind, string, RegExp, RegExp?][] = [
      ['ember', 'Ember', /ember(\.min|\.prod)?\.js|ember-/],
      ['angularjs', 'AngularJS (1.x)', /angular[\w.-]*\.js|angular\//, /\bng-(app|click|model|repeat|controller)\b/],
      ['knockout', 'Knockout.js', /knockout/, /\bdata-bind\s*=/],
      ['polymer', 'Polymer (web components)', /polymer|webcomponents/, /<polymer-element|<dom-module/],
      ['mithril', 'Mithril', /mithril/],
      ['ractive', 'Ractive.js', /ractive/],
      ['canjs', 'CanJS', /(^|\/)can([.\-][\w.-]*)?\.js|canjs/],
      ['backbone', 'Backbone.js', /backbone|marionette|exoskeleton|thorax/],
      ['dojo', 'Dojo', /dojo/],
      ['yui', 'YUI', /yui/],
      ['extjs', 'Ext JS', /ext-all|extjs|ext\.js/],
      ['closure', 'Google Closure', /closure|goog\.js|base\.js.*goog/],
      ['jquery', 'jQuery', /jquery/],
    ];
    // AMD apps (require.js) name their libraries in the config, not in script tags.
    const amd = files.filter((f) => /\.js$/.test(f) && !/(^|\/)(vendor|lib|libs|bower_components)\//.test(rel(f))).slice(0, 12).map((f) => read(f).slice(0, 20000)).join('\n');
    const amdConfig = [...amd.matchAll(/(?:require|requirejs)\.config\(\s*\{[\s\S]*?\}\s*\)/g)].map((m) => m[0]).join('\n').toLowerCase();
    const hay = `${pageScripts.join('\n')}\n${names}\n${amdConfig}`;
    const hit = LIBS.find(([, , re, mark]) => re.test(hay) || (mark && mark.test(html)));
    if (hit) say(hit[0], hit[1], `the page or its files use ${hit[1]}`);
    else if (has(/\.dart$/)) say('dart', 'Dart (compiled to JavaScript)', 'contains .dart files');
    else if (has(/\.gwt\.xml$/) || has(/\.nocache\.js$/)) say('gwt', 'GWT (Java compiled to JavaScript)', 'GWT module files');
    else if (existsSync(join(root, '.meteor'))) say('meteor', 'Meteor', 'a .meteor directory');
    else if (script(/alpine/) || /\bx-data\s*=/.test(html)) say('alpine', 'Alpine.js', 'the page uses x-data / alpine');
    else if (/\bhx-(get|post)\s*=/.test(html)) say('htmx', 'htmx', 'the page uses hx-get / hx-post');
    else if (htmlFiles.length) say('vanilla', 'Plain HTML and JavaScript (no framework Entoli knows)', `${htmlFiles.length} HTML file(s) and ${pageScripts.length} script tag(s); none is a library Entoli recognises`);
    else if (dep('express') || dep('fastify') || dep('koa') || dep('hono')) say('node-server', 'A Node server (no web UI found)', 'a server framework and no HTML');
  }

  // Where the bar goes.
  const firstMatch = (cands: string[]) => cands.find((c) => existsSync(join(root, c))) ?? null;
  const entry = kind === 'nextjs' ? firstMatch(['app/layout.tsx', 'src/app/layout.tsx', 'app/layout.jsx', 'src/app/layout.jsx', 'pages/_app.tsx', 'src/pages/_app.tsx', 'pages/_app.jsx', 'pages/_app.js'])
    : kind === 'nuxt' ? firstMatch(['app.vue', 'app/app.vue'])
    : kind === 'sveltekit' ? firstMatch(['src/routes/+layout.svelte'])
    : kind === 'svelte' ? firstMatch(['src/main.ts', 'src/main.js'])
    : kind === 'vue' || kind === 'vue2' ? firstMatch(['src/main.ts', 'src/main.js'])
    : kind === 'angular' ? firstMatch(['src/main.ts'])
    : ['react', 'preact', 'solid', 'lit', 'qwik'].includes(kind) ? firstMatch(['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'src/main.ts', 'src/main.js', 'src/index.js'])
    : null;
  const page = firstMatch(['index.html', 'public/index.html', 'src/index.html']) ?? (htmlFiles[0] ? rel(htmlFiles[0]) : null);

  const support: Support = ['react', 'nextjs', 'remix'].includes(kind) ? 'full'
    : ['vue', 'vue2', 'nuxt', 'svelte', 'sveltekit', 'preact', 'solid', 'jquery', 'backbone', 'alpine', 'htmx', 'vanilla', 'astro', 'lit', 'qwik', 'angular', 'ember', 'angularjs', 'knockout', 'polymer', 'mithril', 'ractive', 'canjs', 'dojo', 'yui', 'extjs', 'closure', 'gwt', 'dart', 'meteor'].includes(kind) ? (['vue', 'nuxt', 'svelte', 'vue2', 'jquery', 'backbone', 'vanilla', 'alpine', 'htmx', 'angularjs', 'knockout', 'polymer', 'ractive', 'mithril', 'canjs'].includes(kind) ? 'partial' : 'manual')
    : 'none';
  return { kind, label, language: lang, bundler, packageManager: pm, dev, entry, page, evidence, support };
}

// ---- the plan -------------------------------------------------------------------------------------

const MOUNT: Partial<Record<AppKind, (p: Profile) => { title: string; detail: string; code?: string }>> = {
  nextjs: (p) => ({
    title: `Mount the bar once, in ${p.entry ?? 'the root layout'}`,
    detail: 'A client component renders the bar; the layout includes it. Acts are wired with `useEntoli` in the components that already own each function.',
    code: `// components/EntoliBar.tsx\n'use client';\nimport { mount } from '@entoli/sdk';\nimport { useEffect } from 'react';\nimport skill from '../entoli.skill.json';\nexport function EntoliBar() {\n  useEffect(() => { const m = mount({ el: '#entoli', skill }); return () => m.destroy?.(); }, []);\n  return <div id="entoli" />;\n}`,
  }),
  react: (p) => ({
    title: `Mount the bar once, in ${p.entry ?? 'your entry file'}`,
    detail: 'Mount next to your root render. Acts are wired with `useEntoli` inside the components that already own each function.',
    code: `import { mount } from '@entoli/sdk';\nimport skill from './entoli.skill.json';\nmount({ el: '#entoli', skill });   // add <div id="entoli"></div> to index.html`,
  }),
  vue: (p) => ({
    title: `Mount the bar in ${p.entry ?? 'your entry file'}`,
    detail: 'Vue has no Entoli hook yet: call `defineAct` from the code that owns each function (a store action, a method) and mount once.',
    code: `import { mount, defineAct } from '@entoli/sdk';\nimport skill from './entoli.skill.json';\nmount({ el: '#entoli', skill });\ndefineAct('todo.add', { text: 'freeText' }, ({ text }) => store.add(String(text)), { undo: (id) => store.remove(id) });`,
  }),
  svelte: (p) => ({
    title: `Mount the bar in ${p.entry ?? 'your entry file'}`,
    detail: 'Call `defineAct` where the function lives (a store or a component script) and mount once.',
    code: `import { mount, defineAct } from '@entoli/sdk';\nimport skill from './entoli.skill.json';\nmount({ el: '#entoli', skill });`,
  }),
  vanilla: (p) => ({
    title: `Add the bar to ${p.page ?? 'your page'}`,
    detail: 'No build step needed: load the SDK bundle with a script tag and call `Entoli.mount`. Then `Entoli.defineAct` next to the functions your buttons already call.',
    code: `<div id="entoli"></div>\n<script src="entoli.min.js"></script>\n<script>\n  fetch('entoli.skill.json').then((r) => r.json()).then((skill) => Entoli.mount({ el: '#entoli', skill }));\n  Entoli.defineAct('todo.clear', {}, clearCompleted, { undo: restoreCompleted });\n</script>`,
  }),
};
for (const k of ['angularjs', 'knockout', 'polymer', 'mithril', 'ractive', 'canjs', 'dojo', 'yui', 'extjs', 'closure', 'gwt', 'dart', 'meteor', 'ember'] as AppKind[]) MOUNT[k] = (p) => ({ ...MOUNT.vanilla!(p), detail: `${p.label} needs no change to its build: load the SDK bundle with a script tag and call \`Entoli.mount\`. Then \`Entoli.defineAct\` next to the functions your handlers already call.` });
MOUNT.vue2 = MOUNT.vanilla; MOUNT.jquery = MOUNT.vanilla; MOUNT.backbone = MOUNT.vanilla; MOUNT.alpine = MOUNT.vanilla; MOUNT.htmx = MOUNT.vanilla;
MOUNT.nuxt = MOUNT.vue; MOUNT.sveltekit = MOUNT.svelte; MOUNT.remix = MOUNT.react; MOUNT.preact = MOUNT.react; MOUNT.solid = MOUNT.svelte;

export async function planFor(rootIn: string, opts: AnalyzeOptions = {}, precomputed?: AnalyzeResult): Promise<Plan> {
  const root = resolve(rootIn);
  const profile = inspectRepo(root);
  const r = precomputed ?? (await analyze(root, { ai: false, ...opts }));
  const acts = r.skill.acts.map((a) => ({ name: a.name, title: a.title ?? a.name, where: r.sources[a.name]?.[0] ? `${r.sources[a.name]![0]!.file}:${r.sources[a.name]![0]!.line}` : 'no code location (wire it where its handler lives)' }));
  const steps: Plan['steps'] = [];
  const caveats: string[] = [];

  if (profile.support === 'none') {
    caveats.push(profile.kind === 'react-native' ? 'This is a native app. Entoli runs in a browser (DOM), so it cannot operate it. A React Native version of the bar does not exist yet.' : profile.kind === 'node-server' ? 'No web UI was found, so there is nothing for a person to operate by intent here.' : 'The app type was not recognised, so no integration can be recommended yet.');
    return { profile, found: { screens: r.scan.screens.length, controls: r.scan.controls.length, acts }, steps, caveats };
  }

  steps.push({ title: 'Add the SDK', detail: profile.packageManager === 'none' || !profile.dev ? 'There is no package manager here: copy `entoli.min.js` next to your page (Entoli downloads it for you).' : `Install it with ${profile.packageManager === 'npm' ? 'npm i' : `${profile.packageManager} add`} @entoli/sdk.` });
  steps.push({ title: 'Save the skill', detail: `Save the drafted skill as entoli.skill.json (${acts.length} feature${acts.length === 1 ? '' : 's'} found, ${r.scan.screens.length} screen${r.scan.screens.length === 1 ? '' : 's'}). Review the guesses about what is undoable and who it affects before publishing.` });
  const mount = MOUNT[profile.kind];
  if (mount) steps.push(mount(profile));
  if (acts.length) steps.push({ title: 'Wire each feature to the function that already does it', detail: acts.slice(0, 8).map((a) => `${a.name} → ${a.where}`).join('\n') + (acts.length > 8 ? `\n… and ${acts.length - 8} more` : '') + '\nYour own coding agent can do this over MCP, inside the guardrails, or Entoli can prepare the diffs.' });
  else steps.push({ title: 'Name the features by hand', detail: 'The scan found no controls it could turn into features. Describe what people do in this app (or let the model pass read the code), then wire each one.' });
  steps.push({ title: 'Try it', detail: 'Run it in the test sandbox: Entoli walks the map and types every feature\'s phrase into the bar.' });

  if (profile.support === 'partial') caveats.push('Features were read from markup and handlers; where a handler is attached from a selector (jQuery, Backbone) the act is named from its label, and you point `defineAct` at the function that does the work.');
  if (profile.support === 'manual') caveats.push(`${profile.label} can host the bar, but the scan does not read its templates yet: expect to name features by hand (or with the model pass).`);
  if (!acts.length && profile.support !== 'manual') caveats.push('No features were found statically. That is common for apps whose UI is built at runtime; the model pass (ANTHROPIC_API_KEY) reads the code more flexibly.');
  if (!profile.dev) caveats.push('No dev or start script: the sandbox cannot start it as it is. For a plain page, add one (for example "start": "npx serve .").');
  if (Object.values({ ...JSON.parse(read(join(root, 'package.json')) || '{}').dependencies }).some((v) => /^(workspace:|link:|file:\.\.)/.test(String(v)))) caveats.push('It depends on packages inside its own monorepo, so the sandbox cannot install it alone.');
  return { profile, found: { screens: r.scan.screens.length, controls: r.scan.controls.length, acts }, steps, caveats };
}

export function formatPlan(p: Plan): string {
  const L: string[] = [];
  L.push(`${p.profile.label}  ·  ${p.profile.language}  ·  ${p.profile.bundler}  ·  ${p.profile.packageManager}`);
  L.push(`Support: ${p.profile.support.toUpperCase()}${p.profile.dev ? `   start: ${p.profile.dev}` : ''}${p.profile.entry ? `   mount in: ${p.profile.entry}` : p.profile.page ? `   page: ${p.profile.page}` : ''}`);
  L.push(`Evidence: ${p.profile.evidence.join('; ') || 'none'}`);
  L.push(`Found: ${p.found.screens} screen(s), ${p.found.controls} control(s), ${p.found.acts.length} feature(s)${p.found.acts.length ? ': ' + p.found.acts.slice(0, 8).map((a) => a.name).join(', ') : ''}`);
  L.push('');
  p.steps.forEach((s, i) => { L.push(`${i + 1}. ${s.title}`); L.push(s.detail.split('\n').map((x) => `   ${x}`).join('\n')); if (s.code) L.push(s.code.split('\n').map((x) => `     ${x}`).join('\n')); });
  if (p.caveats.length) { L.push(''); L.push('Caveats:'); p.caveats.forEach((c) => L.push(`  - ${c}`)); }
  return L.join('\n');
}
