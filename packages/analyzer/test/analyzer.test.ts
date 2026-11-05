import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { validateSkill } from '@entoli/sdk/skill';
import { describe, expect, it, vi } from 'vitest';
import { analyze, askJson, costMicros, draftSkill, mergeRefinement, scanRepo, summarize } from '../src/index.js';
import { main } from '../src/cli.js';

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('scan: React Router', () => {
  const scan = scanRepo(fx('rr-app'));

  it('finds routes as screens, without treating src/pages as Next routing', () => {
    expect(scan.frameworks).toEqual(expect.arrayContaining(['react', 'react-router']));
    expect(scan.screens.map((s) => s.path).sort()).toEqual(['/', '/settings']);
    expect(scan.appName).toBe('Notes app');
  });

  it('finds forms with their fields, buttons with handlers, and settings', () => {
    const form = scan.controls.find((c) => c.kind === 'form' && c.handler === 'handleCreateNote')!;
    expect(form.label).toBe('Add note');
    expect(form.fields).toEqual([
      expect.objectContaining({ name: 'text', type: 'freeText', required: true }),
      expect.objectContaining({ name: 'tag', type: 'choice', options: ['work', 'home'] }),
    ]);
    expect(form.screen).toBe('home');
    const del = scan.controls.find((c) => c.handler === 'deleteNote')!;
    expect(del).toMatchObject({ kind: 'button', label: 'Delete', testId: 'delete', screen: 'home' });
    expect(scan.controls.find((c) => c.handler === 'shareNote')!.label).toBe('Share with a friend');
    const theme = scan.controls.find((c) => c.handler === 'setTheme')!;
    expect(theme).toMatchObject({ kind: 'select', setting: true, screen: 'settings', options: ['light', 'dark'] });
    expect(scan.controls.filter((c) => c.kind === 'link').map((c) => c.href)).toEqual(['/', '/settings']);
  });
});

describe('scan: Next.js app router and Vue', () => {
  it('maps app/ files to routes (groups dropped, params kept) and follows @/ imports', () => {
    const scan = scanRepo(fx('next-app'));
    expect(scan.screens.map((s) => s.path).sort()).toEqual(['/', '/about', '/notes/:id', '/settings']);
    const add = scan.controls.find((c) => c.handler === 'addTask')!;
    expect(add.screen).toBe('home'); // reached from app/page.tsx through '@/components/NewTask'
    expect(scan.controls.find((c) => c.name === 'language')).toMatchObject({ setting: true, options: ['en', 'fr'] });
  });

  it('reads Vue templates and router objects', () => {
    const scan = scanRepo(fx('vue-app'));
    expect(scan.screens.map((s) => s.path).sort()).toEqual(['/', '/profile']);
    expect(scan.controls.find((c) => c.handler === 'addRecipe')).toMatchObject({ kind: 'button', label: 'Add recipe', screen: 'home' });
    expect(scan.controls.find((c) => c.handler === 'savePassword')).toMatchObject({ kind: 'form', setting: true, screen: 'profile' });
  });
});

describe('scan: monorepo', () => {
  it('detects Next in a nested package and names server-action forms after the action', () => {
    const root = mkdtempSync(join(tmpdir(), 'entoli-mono-'));
    writeFileSync(join(root, 'package.json'), '{"name":"mono","private":true}');
    const page = join(root, 'apps', 'web', 'app', 'items', '[id]');
    mkdirSync(page, { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'package.json'), '{"name":"web","dependencies":{"next":"16.0.0","react":"19.0.0"}}');
    writeFileSync(join(page, 'page.tsx'), `export default function Item() { return <form action={archiveItem.bind(null, 'x')}><button>Archive</button></form>; }`);
    const scan = scanRepo(root);
    expect(scan.frameworks).toEqual(expect.arrayContaining(['next', 'react']));
    expect(scan.screens.map((s) => s.path)).toEqual(['/items/:id']);
    expect(scan.controls[0]).toMatchObject({ kind: 'form', handler: 'archiveItem', label: 'Archive' });
  });
});

describe('draft', () => {
  it('drafts a valid skill whose acts all come from controls, with contract guesses', () => {
    const d = draftSkill(scanRepo(fx('rr-app')));
    const v = validateSkill(d.skill);
    expect(v.ok).toBe(true);
    const by = Object.fromEntries(d.skill.acts.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual(['createNote', 'deleteNote', 'nav.open', 'saveEmail', 'shareNote', 'theme']);
    expect(by.createNote).toMatchObject({ radius: 'self', undo: true, screen: 'home' });
    expect(by.createNote!.slots).toMatchObject({ text: { type: 'freeText' }, tag: { type: 'choice', options: ['work', 'home'] } });
    expect(by.deleteNote).toMatchObject({ radius: 'self' });
    expect(by.deleteNote!.undo).toBeUndefined();
    expect(by.shareNote!.radius).toBe('other-person');
    expect(by.saveEmail).toMatchObject({ radius: 'external', exact: true, kind: 'setting', voiceOnly: true });
    expect(by.theme).toMatchObject({ kind: 'setting', voiceOnly: true, slots: { theme: { type: 'choice', options: ['light', 'dark'], required: true } } });
    expect(d.skill.layer).toBe('L1');
    expect(d.skill.map.find((n) => n.act === 'deleteNote')!.selector).toBe('[data-testid="delete"]');
    expect(by['nav.open']!.slots!.screen!.options).toEqual([{ value: '/', label: 'Notes' }, { value: '/settings', label: 'Settings' }]);
    expect(d.sources.deleteNote).toEqual([expect.objectContaining({ file: 'src/pages/Notes.tsx', component: 'NotesPage', handler: 'deleteNote' })]);
  });

  it('turns loose text inputs into slots of the create button next to them', () => {
    const d = draftSkill(scanRepo(fx('next-app')));
    const add = d.skill.acts.find((a) => a.name === 'addTask')!;
    expect(add.slots).toMatchObject({ taskTitle: { type: 'freeText', required: true }, due: { type: 'when' } });
    expect(d.skill.acts.map((a) => a.name)).not.toContain('setTitle');
  });

  it('works on the real Fieldnotes example', () => {
    const d = draftSkill(scanRepo(fileURLToPath(new URL('../../../examples/notes-app', import.meta.url))));
    expect(validateSkill(d.skill).ok).toBe(true);
    const names = d.skill.acts.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['addNote', 'searchNotes', 'theme', 'fontSize', 'removeNote']));
    expect(d.skill.acts.find((a) => a.name === 'fontSize')!.slots!.fontSize!.type).toBe('quantity');
  });
});

const fakeClient = (reply: unknown, opts: { stop?: string; model?: string } = {}) => {
  const calls: Record<string, unknown>[] = [];
  const msg = {
    model: opts.model ?? 'claude-opus-5-5',
    stop_reason: opts.stop ?? 'end_turn',
    content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const client = {
    beta: { messages: {
      create: vi.fn(async (p: Record<string, unknown>) => { calls.push(p); return msg; }),
      stream: vi.fn((p: Record<string, unknown>) => { calls.push(p); return { finalMessage: async () => msg }; }),
    } },
  } as unknown as Anthropic;
  return { client, calls };
};

describe('askJson', () => {
  it('sends a json_schema output format, the refusal fallback, and prices the call', async () => {
    const { client, calls } = fakeClient({ ok: true });
    const r = await askJson<{ ok: boolean }>({ system: 's', prompt: 'p', schema: { type: 'object' }, effort: 'low', maxTokens: 2048, client });
    expect(r.data).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5', max_tokens: 2048, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
    });
    expect(r.costMicros).toBe(1000 * 4 + 500 * 20);
    expect(costMicros('claude-haiku-5-5', { tokensIn: 1_000_000, tokensOut: 0, cacheRead: 0, cacheWrite: 0 })).toBe(100_000);
  });

  it('streams long outputs and throws on refusal or truncation', async () => {
    const big = fakeClient({});
    await askJson({ system: 's', prompt: 'p', schema: {}, maxTokens: 32000, client: big.client });
    expect((big.client.beta.messages.stream as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    await expect(askJson({ system: 's', prompt: 'p', schema: {}, client: fakeClient({}, { stop: 'refusal' }).client })).rejects.toMatchObject({ reason: 'refusal' });
    await expect(askJson({ system: 's', prompt: 'p', schema: {}, client: fakeClient('{"cut', { stop: 'max_tokens' }).client })).rejects.toMatchObject({ reason: 'truncated' });
    await expect(askJson({ system: 's', prompt: 'p', schema: {}, client: fakeClient('not json').client })).rejects.toMatchObject({ reason: 'invalid_json' });
  });
});

describe('Claude pass', () => {
  const scan = scanRepo(fx('rr-app'));
  const draft = draftSkill(scan);
  const id = (h: string) => scan.controls.find((c) => c.handler === h)!.id;
  const act = (over: Record<string, unknown>) => ({ name: 'x', title: 'X', source_controls: [], phrases: ['x'], radius: 'self', undo: true, exact: false, voice_only: false, is_setting: false, reason: '', slots: [], ...over });

  it('drops acts not backed by the scan, and merges contract fields stricter-wins', () => {
    const ai = {
      screens: [{ id: 'home', title: 'My notes' }],
      acts: [
        act({ name: 'note.create', title: 'New note', source_controls: [id('handleCreateNote')], phrases: ['New note', 'jot down'],
          slots: [{ name: 'text', type: 'freeText', required: true, label: 'Note', prompt: 'What should it say?', options: [] },
                  { name: 'tag', type: 'choice', required: false, label: 'Tag', prompt: '', options: ['work', 'urgent'] }] }),
        act({ name: 'note.share', source_controls: [id('shareNote')], radius: 'self', undo: true }),
        act({ name: 'note.delete', source_controls: [id('deleteNote')], undo: true }),
        act({ name: 'settings.theme', source_controls: [id('setTheme')], is_setting: false }),
        act({ name: 'account.delete', source_controls: ['c999'] }),
        act({ name: 'Bad Name', source_controls: [id('saveEmail')] }),
      ],
      knowledge: [
        { topic: 'export to PDF', can: false, answer: "No, it can't export to PDF.", phrases: [], evidence: 'no export code' },
        { topic: 'teleport', can: true, answer: 'Yes', phrases: [], evidence: '' },
      ],
      notes: [],
    };
    const m = mergeRefinement(scan, draft, ai as never);
    expect(validateSkill(m.skill).ok).toBe(true);
    const by = Object.fromEntries(m.skill.acts.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual(['nav.open', 'note.create', 'note.delete', 'note.share', 'settings.theme']);
    expect(m.dropped).toEqual(expect.arrayContaining(['account.delete', 'Bad Name', 'knowledge "teleport" (no evidence)']));
    expect(by['note.share']!.radius).toBe('other-person'); // the model said self; the code says share
    expect(by['note.delete']!.undo).toBeUndefined(); // the model said undo; the static pass said no
    expect(by['settings.theme']).toMatchObject({ kind: 'setting', voiceOnly: true });
    expect(by['note.create']!.phrases).toEqual(['new note', 'jot down']);
    expect(by['note.create']!.slots!.tag!.options).toEqual(['work']); // 'urgent' is not in the code
    expect(m.skill.map.find((n) => n.act === 'note.create')).toBeTruthy();
    expect(m.skill.map.find((n) => n.id === 'home')!.title).toBe('My notes');
    expect(m.skill.knowledge).toEqual([{ topic: 'export to PDF', can: false, answer: "No, it can't export to PDF." }]);
    expect(m.sources['note.create']).toEqual([expect.objectContaining({ file: 'src/pages/Notes.tsx', handler: 'handleCreateNote' })]);
  });

  it('caps the summary sent to the model', () => {
    const big = { ...scan, controls: Array.from({ length: 400 }, (_, i) => ({ ...scan.controls[2]!, id: `c${i + 1}`, label: `Control number ${i} with a longish label` })) };
    const { text, omitted } = summarize(big, draft, 2000);
    expect(text.length).toBeLessThanOrEqual(2000 * 3.5 + 2000);
    expect(omitted).toBeGreaterThan(0);
  });

  it('analyze() uses the model when a client is given, and falls back to the static draft on refusal', async () => {
    const reply = { screens: [], acts: [act({ name: 'note.create', source_controls: [id('handleCreateNote')] })], knowledge: [], notes: ['looks fine'] };
    const ok = await analyze(fx('rr-app'), { client: fakeClient(reply).client });
    expect(ok.usedModel).toBe(true);
    expect(ok.costMicros).toBe(14_000);
    expect(ok.skill.acts.map((a) => a.name).sort()).toEqual(['nav.open', 'note.create']);
    const refused = await analyze(fx('rr-app'), { client: fakeClient({}, { stop: 'refusal' }).client });
    expect(refused.usedModel).toBe(false);
    expect(refused.skill.acts.length).toBe(draft.skill.acts.length);
    expect(refused.costMicros).toBe(14_000); // a declined call is still logged
    expect(refused.log.join('\n')).toMatch(/keeping the static draft/);
    const off = await analyze(fx('rr-app'), { ai: false });
    expect(off.usedModel).toBe(false);
    expect(off.log.join('\n')).toMatch(/heuristic guesses/);
  });
});

describe('CLI', () => {
  it('entoli analyze <path> --no-ai --print writes the skill to stdout', async () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
    const e = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main(['analyze', fx('vue-app'), '--no-ai', '--print']);
    w.mockRestore(); e.mockRestore();
    expect(code).toBe(0);
    const skill = JSON.parse(out.join(''));
    expect(validateSkill(skill).ok).toBe(true);
    expect(skill.app.name).toBe('Recipes');
  });

  it('rejects unknown commands', async () => {
    const e = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['scan', '.'])).toBe(1);
    e.mockRestore();
  });
});
