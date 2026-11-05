import { describe, expect, it, vi } from 'vitest';
import { Entoli, type RemoteResolver } from '../src/runtime.js';
import { NO_KNOWLEDGE } from '../src/knowledge.js';
import { skill, FakeTimers } from './fixture.js';

function setup(resolver?: RemoteResolver, layer: 'L1' | 'L2' = 'L1') {
  const timers = new FakeTimers();
  const e = new Entoli({ skill, timers, layer, ...(resolver ? { resolver } : {}) });
  const notes: { id: number; text: string }[] = [];
  let theme = 'light';
  let email = 'old@example.com';
  const create = vi.fn(({ text }: Record<string, unknown>) => { const n = { id: notes.length + 1, text: String(text) }; notes.push(n); return n; });
  e.register('note.create', {}, create, { undo: (n) => { notes.splice(notes.findIndex((x) => x.id === (n as { id: number }).id), 1); } });
  const setTheme = vi.fn(({ theme: t }: Record<string, unknown>) => { const prev = theme; theme = String(t); return prev; });
  e.register('settings.theme', {}, setTheme, { undo: (prev) => { theme = String(prev); } });
  const setEmail = vi.fn(({ email: v }: Record<string, unknown>) => { email = String(v); });
  e.register('settings.email', {}, setEmail);
  const share = vi.fn();
  e.register('note.share', {}, share, { undo: () => {} });
  return { e, timers, notes, create, setTheme, setEmail, share, get theme() { return theme; }, get email() { return email; } };
}

describe('runtime: on device', () => {
  it('self + undo runs after the 1.6 s hold, and can be undone', async () => {
    const t = setup();
    const s = await t.e.hear('new note buy milk');
    expect(s.phase).toBe('hold');
    expect(s.via).toBe('device');
    expect(s.args?.[0]).toMatchObject({ name: 'text', display: 'buy milk' });
    await t.timers.advance(1599);
    expect(t.create).not.toHaveBeenCalled();
    await t.timers.advance(1);
    expect(t.create).toHaveBeenCalledWith({ text: 'buy milk' }, { channel: 'text', act: 'note.create' });
    expect(t.e.state.phase).toBe('done');
    const r = t.e.state.receipts[0]!;
    expect(r.undoable).toBe(true);
    expect(t.notes).toHaveLength(1);
    expect(await t.e.undo(r.id)).toBe(true);
    expect(t.notes).toHaveLength(0);
    expect(t.e.state.receipts[0]!.undone).toBe(true);
    expect(await t.e.undo(r.id)).toBe(false);
  });

  it('"Not that" during the hold means nothing runs', async () => {
    const t = setup();
    await t.e.hear('new note call the bank');
    t.e.notThat();
    await t.timers.advance(5000);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.e.state.phase).toBe('idle');
  });

  it('saying "no" during the hold also stops it', async () => {
    const t = setup();
    await t.e.hear('new note call the bank');
    await t.e.hear('no');
    await t.timers.advance(5000);
    expect(t.create).not.toHaveBeenCalled();
  });

  it('a setting needs an explicit yes, even with undo', async () => {
    const t = setup();
    const s = await t.e.hear('switch to dark mode');
    expect(s.phase).toBe('confirm');
    await t.timers.advance(5000);
    expect(t.setTheme).not.toHaveBeenCalled();
    await t.e.confirm();
    expect(t.theme).toBe('dark');
  });

  it('asks for a missing slot and takes the next phrase as the answer', async () => {
    const t = setup();
    const s = await t.e.hear('change the theme');
    expect(s.phase).toBe('ask');
    expect(s.ask?.options).toEqual(['dark', 'light']);
    const s2 = await t.e.hear('light');
    expect(s2.phase).toBe('confirm');
    await t.e.hear('yes');
    expect(t.setTheme).toHaveBeenCalledWith({ theme: 'light' }, expect.anything());
  });

  it('other-person needs a yes', async () => {
    const t = setup();
    const s = await t.e.hear('share note with Maya');
    expect(s.phase).toBe('confirm');
    expect(s.args?.[0]?.value).toBe('Maya');
  });
});

describe('runtime: exact and voice only', () => {
  it('typed email change is refused', async () => {
    const t = setup();
    const s = await t.e.hear('change my email to ana@example.com');
    expect(s.phase).toBe('blocked');
    expect(t.setEmail).not.toHaveBeenCalled();
  });

  it('spoken email change shows every argument and binds the yes to the fingerprint', async () => {
    const t = setup();
    const s = await t.e.hear('change my email to ana@example.com', { channel: 'voice' });
    expect(s.phase).toBe('exact');
    expect(s.args).toEqual([expect.objectContaining({ name: 'email', display: 'ana@example.com' })]);
    expect(s.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // A yes without the fingerprint, or with another card's, does nothing.
    await t.e.confirm('0000000000000000');
    expect(t.e.state.phase).toBe('error');
    expect(t.setEmail).not.toHaveBeenCalled();

    const s2 = await t.e.hear('change my email to ana@example.com', { channel: 'voice' });
    await t.e.confirm(s2.fingerprint);
    expect(t.email).toBe('ana@example.com');
    expect(t.e.state.receipts[0]!.undoable).toBe(false);
  });

  it('a spoken "yes" confirms the card that is showing', async () => {
    const t = setup();
    await t.e.hear('change my email to bo@example.com', { channel: 'voice' });
    await t.e.hear('yes', { channel: 'voice' });
    expect(t.email).toBe('bo@example.com');
  });

  it('the external act never holds, even if code registers it as self', async () => {
    const timers = new FakeTimers();
    const e = new Entoli({ skill, timers });
    const fn = vi.fn();
    e.register('settings.email', {}, fn, { radius: 'self', undo: () => {} });
    const s = await e.hear('change my email to x@y.z', { channel: 'voice' });
    expect(s.phase).toBe('exact');
  });

  it('an act with no undo function never holds', async () => {
    const timers = new FakeTimers();
    const e = new Entoli({ skill, timers });
    const fn = vi.fn();
    e.register('note.create', {}, fn);
    expect((await e.hear('new note hello')).phase).toBe('confirm');
  });
});

describe('runtime: knowledge', () => {
  it('answers only from skill.knowledge', async () => {
    const t = setup();
    const s = await t.e.hear('can it export my notes to pdf?');
    expect(s.phase).toBe('answer');
    expect(s.can).toBe(false);
    expect(s.message).toMatch(/PDF/);
    const s2 = await t.e.hear('does it support tags?');
    expect(s2.can).toBe(true);
    const s3 = await t.e.hear('can it sync with dropbox?');
    expect(s3.message).toBe(NO_KNOWLEDGE);
    expect(s3.can).toBeNull();
  });
});

describe('Layer 1: no Entoli AI (bring your own resolver)', () => {
  it('asks your resolver only when nothing matched on the device', async () => {
    const resolver = vi.fn<RemoteResolver>(async () => null);
    const t = setup(resolver, 'L1');
    await t.e.hear('new note x');
    expect(resolver).not.toHaveBeenCalled();
    await t.e.hear('make it look like midnight');
    expect(resolver).toHaveBeenCalledOnce();
    const req = resolver.mock.calls[0]![0];
    expect(req.layer).toBe('L1');
    expect(req.acts.map((a) => a.name).sort()).toEqual(['note.create', 'note.share', 'settings.email', 'settings.theme']);
    expect(req.acts.find((a) => a.name === 'settings.theme')!.slots.theme).toEqual({ type: 'choice', options: ['dark', 'light'] });
  });

  it('a resolver\'s choice goes under the contract and never holds', async () => {
    const t = setup(async () => ({ act: 'settings.theme', slots: { theme: 'dark' } }), 'L1');
    const s = await t.e.hear('make it look like midnight');
    expect(s).toMatchObject({ phase: 'confirm', via: 'model', act: 'settings.theme' });
  });

  it('the resolver cannot invent an act or an option', async () => {
    const t = setup(async () => ({ act: 'account.delete', slots: {} }), 'L1');
    expect((await t.e.hear('nuke everything')).phase).toBe('none');
    const t2 = setup(async () => ({ act: 'settings.theme', slots: { theme: 'neon', extra: 1 } }), 'L1');
    const s = await t2.e.hear('make it neon');
    expect(s.phase).toBe('ask');
    expect(s.args).toEqual([]);
  });

  it('acts not declared in the skill are not offered', async () => {
    const resolver = vi.fn<RemoteResolver>(async () => ({ act: 'secret', slots: {} }));
    const t = setup(resolver, 'L1');
    t.e.register('secret', { x: 'freeText' }, vi.fn(), { radius: 'self', phrases: ['zzz qqq'] });
    await t.e.hear('something odd');
    expect(resolver.mock.calls[0]![0].acts.map((a) => a.name)).not.toContain('secret');
    expect(t.e.state.phase).toBe('none');
  });

  it('an app key alone never calls Entoli on Layer 1', async () => {
    const f = vi.fn();
    const e = new Entoli({ skill, layer: 'L1', key: 'ek_live_x', fetch: f as unknown as typeof fetch, timers: new FakeTimers() });
    e.register('note.create', {}, vi.fn(), { undo: () => {} });
    expect((await e.hear('make it look like midnight')).phase).toBe('none');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('Layer 2: the AI answers, then the change goes on the card', () => {
  it('asks the AI for every new request, with the device\'s match as a hint', async () => {
    const resolver = vi.fn<RemoteResolver>(async () => ({ act: 'note.create', slots: {}, say: 'Adding that note.' }));
    const t = setup(resolver, 'L2');
    const s = await t.e.hear('new note buy milk');
    expect(resolver.mock.calls[0]![0]).toMatchObject({ phrase: 'new note buy milk', layer: 'L2', hint: 'note.create' });
    // The AI agreed with the device, so the small reversible act still runs after the hold.
    expect(s).toMatchObject({ phase: 'hold', reply: 'Adding that note.', via: 'device', args: [expect.objectContaining({ display: 'buy milk' })] });
    await t.timers.advance(1600);
    expect(t.create).toHaveBeenCalledWith({ text: 'buy milk' }, expect.anything());
  });

  it('a choice only the AI made waits for a yes, and shows what it said', async () => {
    const t = setup(async () => ({ act: 'settings.theme', slots: { theme: 'dark' }, say: 'Switching to the dark theme.' }), 'L2');
    const s = await t.e.hear('make it look like midnight');
    expect(s).toMatchObject({ phase: 'confirm', via: 'model', reply: 'Switching to the dark theme.', act: 'settings.theme' });
  });

  it('a reply without an act is an answer, not an action', async () => {
    const t = setup(async () => ({ act: null, say: 'I can add, search and tag notes.' }), 'L2');
    const s = await t.e.hear('what can you do for me');
    expect(s).toMatchObject({ phase: 'answer', message: 'I can add, search and tag notes.', via: 'model' });
    expect(t.create).not.toHaveBeenCalled();
  });

  it('falls back to the device when the AI is unreachable', async () => {
    const t = setup(async () => { throw new Error('offline'); }, 'L2');
    expect((await t.e.hear('new note call mum')).phase).toBe('hold');
    const s = await t.e.hear('something odd');
    expect(s.phase).toBe('error');
    expect(s.message).toMatch(/offline/);
  });

  it('yes and no answer the card on the device, without the AI', async () => {
    const resolver = vi.fn<RemoteResolver>(async () => ({ act: 'settings.theme', slots: { theme: 'dark' }, say: 'OK.' }));
    const t = setup(resolver, 'L2');
    await t.e.hear('make it look like midnight');
    await t.e.hear('yes');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(t.theme).toBe('dark');
  });
});

describe('runtime: prepare', () => {
  it('normalises before the card, so the exact card shows what runs', async () => {
    const timers = new FakeTimers();
    const e = new Entoli({ skill, timers });
    const fn = vi.fn();
    e.register('settings.email', {}, fn, {
      prepare: (s) => {
        const v = String(s.email).replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+/g, '').toLowerCase();
        return /^[^@]+@[^@]+\.[a-z]+$/.test(v) ? { email: v } : `"${v}" is not an email address.`;
      },
    });
    const s = await e.hear('change my email to Ana at example dot com', { channel: 'voice' });
    expect(s.args?.[0]?.display).toBe('ana@example.com');
    await e.confirm(s.fingerprint);
    expect(fn).toHaveBeenCalledWith({ email: 'ana@example.com' }, expect.anything());
    const bad = await e.hear('change my email to nobody', { channel: 'voice' });
    expect(bad.phase).toBe('error');
    expect(bad.message).toMatch(/not an email/);
  });
});

describe('runtime: server errors', () => {
  it('shows the server\'s own error message (Layer 2 with an app key)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'Entoli AI is part of the L2 plan.' }), { status: 402 }));
    const e = new Entoli({ skill, layer: 'L2', key: 'ek_live_x', endpoint: 'https://api.test', fetch: f as unknown as typeof fetch, timers: new FakeTimers() });
    e.register('note.create', {}, vi.fn(), { undo: () => {} });
    const s = await e.hear('something entirely different');
    expect(f).toHaveBeenCalledWith('https://api.test/api/intent', expect.objectContaining({ method: 'POST' }));
    expect(s.phase).toBe('error');
    expect(s.message).toMatch(/L2 plan/);
  });
});

describe('runtime: confirm "always"', () => {
  it('turns the silent hold into an explicit yes, and nothing looser', async () => {
    const timers = new FakeTimers();
    const e = new Entoli({ skill, timers, confirm: 'always' });
    const fn = vi.fn();
    e.register('note.create', {}, fn, { undo: () => {} });
    e.register('settings.email', {}, vi.fn());
    const s = await e.hear('new note call the bank');
    expect(s).toMatchObject({ phase: 'confirm', why: 'This app asks before every action.' });
    await timers.advance(5000);
    expect(fn).not.toHaveBeenCalled();
    expect((await e.hear('change my email to a@b.co', { channel: 'voice' })).phase).toBe('exact');
  });
});

describe('per-act layers', () => {
  const mixed = {
    ...skill,
    layer: 'L1' as const,
    acts: skill.acts.map((a) =>
      a.name === 'settings.theme' ? { ...a, layer: 'L2' as const }
      : a.name === 'settings.email' ? { ...a, layer: 'off' as const }
      : a),
  };

  it('offers the AI only Layer 2 acts; device-only acts never reach it; "off" acts are not connected', async () => {
    const resolver = vi.fn<RemoteResolver>(async () => ({ act: 'settings.theme', slots: { theme: 'dark' }, say: 'Dark it is.' }));
    const e = new Entoli({ skill: mixed, timers: new FakeTimers(), key: 'ek_live_x', fetch: (async () => new Response('{}')) as never, resolver });
    const create = vi.fn();
    e.register('note.create', {}, create, { undo: () => {} });
    e.register('settings.theme', {}, vi.fn(), { undo: () => {} });
    const email = vi.fn();
    e.register('settings.email', {}, email);
    expect(e.registered()).not.toContain('settings.email');

    // An L1 act understood on the device: no AI call.
    expect((await e.hear('new note milk')).phase).toBe('hold');
    expect(resolver).not.toHaveBeenCalled();

    // Anything else: the AI, but only with the L2 act on offer.
    const s = await e.hear('make it look like midnight');
    expect(resolver.mock.calls[0]![0].acts.map((a) => a.name)).toEqual(['settings.theme']);
    expect(s).toMatchObject({ act: 'settings.theme', reply: 'Dark it is.' });

    // The "off" act cannot be reached by any phrase.
    await e.hear('change my email to a@b.co', { channel: 'voice' });
    expect(email).not.toHaveBeenCalled();
  });

  it('refuses an AI pick of a device-only act', async () => {
    const e = new Entoli({ skill: mixed, timers: new FakeTimers(), resolver: async () => ({ act: 'note.create', slots: { text: 'x' }, say: 'Adding.' }) });
    e.register('note.create', {}, vi.fn(), { undo: () => {} });
    e.register('settings.theme', {}, vi.fn(), { undo: () => {} });
    const s = await e.hear('jot something down about the meeting');
    expect(s.act).toBeUndefined();
    expect(s.message).not.toBe('Adding.');
  });
});
