import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPlan, inspectRepo, planFor } from '../src/index.js';

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'entoli-inspect-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  return dir;
}
const pkg = (o: object) => JSON.stringify(o);

describe('recognising the kind of app, from evidence', () => {
  it.each([
    ['Next.js App Router', { 'package.json': pkg({ dependencies: { next: '15.0.0', react: '19' } }), 'app/layout.tsx': 'export default function L(){return null}', 'tsconfig.json': '{}' }, 'nextjs', 'full', 'app/layout.tsx'],
    ['React + Vite', { 'package.json': pkg({ dependencies: { react: '18' }, devDependencies: { vite: '5' }, scripts: { dev: 'vite' } }), 'src/main.jsx': 'x', 'src/App.jsx': 'export const A=()=><button>Hi</button>' }, 'react', 'full', 'src/main.jsx'],
    ['Vue 3', { 'package.json': pkg({ dependencies: { vue: '^3.4.0' } }), 'src/main.ts': 'x' }, 'vue', 'partial', 'src/main.ts'],
    ['Vue 2', { 'package.json': pkg({ dependencies: { vue: '^2.7.0' } }) }, 'vue2', 'partial', null],
    ['Svelte', { 'package.json': pkg({ devDependencies: { svelte: '5' } }), 'src/main.js': 'x' }, 'svelte', 'partial', 'src/main.js'],
    ['Angular', { 'package.json': pkg({ dependencies: { '@angular/core': '17' } }), 'src/main.ts': 'x' }, 'angular', 'manual', 'src/main.ts'],
    ['Expo', { 'package.json': pkg({ dependencies: { expo: '52', 'react-native': '0.76' } }) }, 'react-native', 'none', null],
    ['jQuery page', { 'index.html': '<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script><button id="go">Go</button>' }, 'jquery', 'partial', null],
    ['AngularJS page', { 'index.html': '<html ng-app="x"><script src="angular.js"></script><button ng-click="add()">Add</button></html>' }, 'angularjs', 'partial', null],
    ['Knockout page', { 'index.html': '<button data-bind="click: save">Save</button>' }, 'knockout', 'partial', null],
    ['plain page', { 'index.html': '<button id="a">A</button>', 'app.js': 'x' }, 'vanilla', 'partial', null],
    ['a server', { 'package.json': pkg({ dependencies: { express: '4' } }), 'server.js': 'x' }, 'node-server', 'none', null],
  ] as const)('%s', (_n, files, kind, support, entry) => {
    const p = inspectRepo(repo(files as Record<string, string>));
    expect(p.kind).toBe(kind);
    expect(p.support).toBe(support);
    expect(p.entry).toBe(entry);
    expect(p.evidence.length).toBeGreaterThan(0);
  });

  it('prefers the framework over the library it also loads (TodoMVC-style pages load jQuery too)', () => {
    const p = inspectRepo(repo({ 'index.html': '<script src="jquery.js"></script><script src="backbone.js"></script>' }));
    expect(p.kind).toBe('backbone');
  });

  it('reads require.js config to find AMD libraries', () => {
    const p = inspectRepo(repo({ 'index.html': '<script data-main="js/app" src="require.js"></script>', 'js/app.js': "require.config({ paths: { backbone: 'lib/backbone' } });" }));
    expect(p.kind).toBe('backbone');
  });

  it('knows TypeScript, the package manager and the start command', () => {
    const p = inspectRepo(repo({ 'package.json': pkg({ scripts: { dev: 'vite' }, dependencies: { react: '18' } }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}' }));
    expect(p).toMatchObject({ language: 'typescript', packageManager: 'pnpm', dev: 'pnpm run dev' });
  });
});

describe('features in markup, not only in React', () => {
  it('reads HTML, Svelte and HTML inside JavaScript strings, and names unlabeled buttons from their id or class', async () => {
    const html = await planFor(repo({ 'index.html': '<input id="new-todo" placeholder="What needs doing?"><button id="clear-completed">Clear completed</button><button class="destroy"></button>' }));
    expect(html.found.acts.map((a) => a.name)).toEqual(expect.arrayContaining(['newTodo', 'clearCompleted']));
    const svelte = await planFor(repo({ 'package.json': pkg({ devDependencies: { svelte: '5' } }), 'src/Counter.svelte': '<script>let n = 0; function inc() { n++; }</script>\n<button onclick={() => inc()}>Add one</button>' }));
    expect(svelte.found.acts.map((a) => a.name)).toContain('inc');
    const js = await planFor(repo({ 'index.html': '<div id="app"></div>', 'main.js': "document.getElementById('app').innerHTML = `<button id=\"counter\" type=\"button\">Count</button>`;" }));
    expect(js.found.acts.length).toBeGreaterThan(0);
  });

  it('keeps quoted > and handlebars out of the way', async () => {
    const p = await planFor(repo({ 'index.html': `<button v-show="todos.length > remaining" @click="clearAll()">Clear all</button><a {{#eq f 'all'}}class="x"{{/eq}} href="/x">X</a>` }));
    expect(p.found.acts.map((a) => a.name)).toContain('clearAll');
  });
});

describe('the plan', () => {
  it('is concrete for this app and honest about gaps', async () => {
    const dir = repo({ 'package.json': pkg({ dependencies: { next: '15', react: '19' } }), 'app/layout.tsx': 'x', 'app/page.tsx': "'use client';\nexport default function P(){ return <button onClick={() => save()}>Save</button>; }" });
    const p = await planFor(dir);
    const text = formatPlan(p);
    expect(text).toMatch(/Next\.js \(App Router\)/);
    expect(text).toMatch(/Mount the bar once, in app\/layout\.tsx/);
    expect(p.steps.length).toBeGreaterThanOrEqual(5);
    const rn = await planFor(repo({ 'package.json': pkg({ dependencies: { expo: '52' } }) }));
    expect(rn.steps).toEqual([]);
    expect(rn.caveats[0]).toMatch(/native app/);
    const mono = await planFor(repo({ 'package.json': pkg({ dependencies: { react: '18', '@acme/ui': 'workspace:*' } }), 'src/main.tsx': 'x' }));
    expect(mono.caveats.join(' ')).toMatch(/monorepo/);
  });
});
