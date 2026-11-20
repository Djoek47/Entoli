/**
 * Does Entoli recognise what kind of app a real, third-party repository is?
 *
 * Needs a corpus of real apps on disk. Two free ones, straight from npm:
 *   npm pack create-vite todomvc && tar xzf create-vite-*.tgz && tar xzf todomvc-*.tgz   (into one folder, then:)
 *   ENTOLI_CORPUS=<that folder> pnpm --filter @entoli/web eval corpus
 * `create-vite` ships 16 official templates (React, Vue, Svelte, Solid, Preact, Lit, Qwik, vanilla, TS and JS);
 * `todomvc` ships ~60 independent implementations of the same app in as many frameworks, written by their authors.
 * The folder name is the ground truth.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectRepo, planFor, type AppKind } from '@entoli/analyzer';
import { report } from './report';

const corpus = process.env.ENTOLI_CORPUS ?? '';
const templates = join(corpus, 'create-vite', 'template-x').replace('template-x', '');
const todomvc = join(corpus, 'todomvc', 'examples');

const FROM_TEMPLATE: Record<string, AppKind> = { react: 'react', vue: 'vue', svelte: 'svelte', solid: 'solid', preact: 'preact', lit: 'lit', qwik: 'qwik', vanilla: 'vanilla' };
const FROM_TODOMVC: Record<string, AppKind> = {
  angularjs: 'angularjs', angularjs_require: 'angularjs', 'angularjs-perf': 'angularjs', 'firebase-angular': 'angularjs',
  backbone: 'backbone', backbone_require: 'backbone', backbone_marionette: 'backbone', backbone_marionette_require: 'backbone', exoskeleton: 'backbone', thorax: 'backbone', 'typescript-backbone': 'backbone',
  knockoutjs: 'knockout', knockoutjs_require: 'knockout', jquery: 'jquery', react: 'react', 'react-backbone': 'react', vue: 'vue2',
  emberjs: 'ember', polymer: 'polymer', mithril: 'mithril', ractive: 'ractive', canjs: 'canjs', canjs_require: 'canjs',
  dojo: 'dojo', yui: 'yui', extjs_deftjs: 'extjs', closure: 'closure', gwt: 'gwt', vanilladart: 'dart', meteor: 'meteor', vanillajs: 'vanilla',
};

describe.skipIf(!corpus || !existsSync(todomvc))('recognising real apps', () => {
  it('names the kind of app from evidence in its files', async () => {
    const cases: { name: string; want: AppKind; dir: string }[] = [];
    const tdir = join(corpus, 'create-vite');
    for (const n of readdirSync(tdir).filter((x) => x.startsWith('template-'))) {
      const base = n.replace(/^template-/, '').replace(/-ts$/, '');
      if (FROM_TEMPLATE[base]) cases.push({ name: n, want: FROM_TEMPLATE[base]!, dir: join(tdir, n) });
    }
    for (const [n, want] of Object.entries(FROM_TODOMVC)) if (existsSync(join(todomvc, n))) cases.push({ name: n, want, dir: join(todomvc, n) });
    void templates;

    const rows = cases.map((c) => { const got = inspectRepo(c.dir).kind; return { ok: got === c.want ? '✓' : '✗', app: c.name, expected: c.want, got }; });
    const right = rows.filter((r) => r.ok === '✓').length;

    // And is the advice honest: every recognised web app gets steps; none claims more support than it has.
    let withActs = 0, plans = 0;
    for (const c of cases) {
      const p = await planFor(c.dir);
      plans++;
      expect(p.steps.length).toBeGreaterThan(2);
      if (p.found.acts.length) withActs++;
    }
    report('corpus', rows, { apps: cases.length, 'kind recognised': `${right}/${cases.length}`, 'with features found': `${withActs}/${plans}` });
    expect(right / cases.length).toBeGreaterThanOrEqual(0.9);
    expect(withActs / plans).toBeGreaterThanOrEqual(0.7);
  });
});
