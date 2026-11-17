import { beforeAll, describe, expect, it } from 'vitest';
import { actLayer, validateSkill, type Skill } from '@entoli/sdk/skill';
import { memoryDb, type DB } from '@/db';
import { announce } from '@/lib/agent-announce';
import { createApp, getApp, saveSkill, setPlan, skillOf, upsertUser } from '@/lib/apps';
import { acceptProposal, applyProposal, buildProposal, explain, proposalOf, proposeFor, revertProposal, undoProposal } from '@/lib/proposal';
import { STUDIO_SKILL } from '@/lib/studio-skill';
import raw from '../../../examples/notes-app/entoli.skill.json';

const skill = raw as unknown as Skill;
let db: DB;
beforeAll(async () => { db = await memoryDb(); });

describe('the proposal', () => {
  const p = buildProposal(skill, new Date('2026-11-17T10:00:00Z'));
  const by = Object.fromEntries(p.items.map((i) => [i.act, i]));

  it('hands the AI the acts where one sentence replaces several clicks', () => {
    expect(by['note.create']).toMatchObject({ recommend: 'L2' });   // free text, undoable
    expect(by['note.search']).toMatchObject({ recommend: 'L2' });
    expect(by['note.create']!.reason).toMatch(/one spoken sentence replaces several clicks/);
  });

  it('keeps short, predictable acts on the device (no AI, no cost)', () => {
    for (const a of ['note.tag', 'note.delete', 'nav.open', 'settings.theme']) expect(by[a], a).toMatchObject({ recommend: 'L1' });
    expect(by['nav.open']!.reason).toMatch(/Opening a screen/);
  });

  it('keeps manual what reaches outside the app, with the reason', () => {
    expect(by['settings.email']).toMatchObject({ recommend: 'off' });
    expect(by['settings.email']!.reason).toMatch(/reaches outside the app/);
  });

  it('keeps destructive acts without undo manual, but not ones that can be undone', () => {
    const s: Skill = { ...skill, acts: [
      { name: 'account.delete', title: 'Delete account', phrases: ['delete my account'], radius: 'self' },
      { name: 'note.delete', title: 'Delete note', phrases: ['delete note'], radius: 'self', undo: true },
      { name: 'order.pay', title: 'Pay', phrases: ['pay now'], radius: 'self' },
    ], map: [] };
    const q = Object.fromEntries(buildProposal(s).items.map((i) => [i.act, i]));
    expect(q['account.delete']).toMatchObject({ recommend: 'off' });
    expect(q['order.pay']).toMatchObject({ recommend: 'off' });
    expect(q['note.delete']!.recommend).not.toBe('off');
  });

  it('helps with acts that affect other people, but says it always asks', () => {
    const s: Skill = { ...skill, map: [], acts: [{ name: 'note.share', title: 'Share note', phrases: ['share note'], radius: 'other-person', undo: true, slots: { person: { type: 'person', required: true, options: ['Maya'] }, text: { type: 'freeText' } } }] };
    expect(buildProposal(s).items[0]).toMatchObject({ recommend: 'L2' });
    expect(buildProposal(s).items[0]!.reason).toMatch(/always asks for a yes/);
  });

  it('is deterministic, and speaks as a conversation: counts, groups, what changes, what to say next', () => {
    expect(buildProposal(skill, new Date('2026-11-17T10:00:00Z'))).toEqual(p);
    expect(p.spoken).toMatch(/^I found 8 features\./);
    expect(p.spoken).toMatch(/I would hand New note, Search notes and Change font size to the AI/);
    expect(p.spoken).toMatch(/I would keep Tag note, Delete note, Go to and 1 more on the device/);
    expect(p.spoken).toMatch(/leave Change email manual/);
    expect(p.spoken).toMatch(/Say accept to apply it, or ask why/);
    expect(buildProposal({ ...skill, acts: [], map: [] }).spoken).toMatch(/Analyze your repository first/);
  });

  it('explains each choice on request', () => {
    expect(explain(p, 'settings.email')).toMatch(/^Change email: I would put it on kept manual\. It reaches outside the app/);
    expect(explain(p, 'nope')).toMatch(/do not have a recommendation/);
  });
});

describe('applying and undoing', () => {
  it('sets layers per act (inherit when equal to the app layer), only where it changes, and reverts exactly', () => {
    const p = buildProposal(skill);
    const { skill: next, applied } = applyProposal(skill, p);
    expect(validateSkill(next).ok).toBe(true);
    const layer = (n: string) => actLayer(next, next.acts.find((a) => a.name === n)!);
    expect(layer('note.create')).toBe('L2');
    expect(layer('note.tag')).toBe('L1');
    expect(layer('settings.email')).toBe('off');
    expect(next.acts.find((a) => a.name === 'note.create')!.layer).toBeUndefined(); // app is L2: inherits
    expect(next.acts.find((a) => a.name === 'note.tag')!.layer).toBe('L1');
    expect(Object.keys(applied).length).toBe(p.items.filter((i) => i.change).length);
    const back = revertProposal(next, applied);
    expect(back.acts.map((a) => [a.name, a.layer])).toEqual(skill.acts.map((a) => [a.name, a.layer]));
  });

  it('through the database: propose, accept (draft skill changes), undo; refuses twice and without a proposal', async () => {
    const u = await upsertUser(db, { githubId: `p${Math.random()}`, login: 'dev' });
    const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
    await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
    expect((await saveSkill(db, u.id, app.id, skill, 'draft')).ok).toBe(true);
    const get = async () => (await getApp(db, u.id, app.id))!;

    await expect(acceptProposal(db, await get())).rejects.toThrow(/no proposal to accept/);
    const p = await proposeFor(db, await get());
    expect(proposalOf(await get())!.spoken).toBe(p.spoken);
    const r = await acceptProposal(db, await get());
    expect(r.changed).toBe(p.items.filter((i) => i.change).length);
    const after = skillOf(await get())!;
    expect(actLayer(after, after.acts.find((a) => a.name === 'settings.email')!)).toBe('off');
    await expect(acceptProposal(db, await get())).rejects.toThrow(/already applied/);

    await undoProposal(db, await get());
    const restored = skillOf(await get())!;
    expect(restored.acts.map((a) => a.layer)).toEqual(skill.acts.map((a) => a.layer));
    expect(proposalOf(await get())!.applied).toBeUndefined();
  });

  it('is part of the L2 plan, and needs a skill', async () => {
    const u = await upsertUser(db, { githubId: `p${Math.random()}`, login: 'dev' });
    const { app } = await createApp(db, u.id, { name: 'X' });
    await expect(proposeFor(db, await getApp(db, u.id, app.id) as never)).rejects.toThrow(/L2 plan/);
    await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
    await expect(proposeFor(db, (await getApp(db, u.id, app.id))!)).rejects.toThrow(/Analyze the repository first/);
  });
});

describe('announcing what the developer\'s agent does', () => {
  const ev = (o: Partial<{ id: string; kind: string; act: string | null; status: string | null; note: string | null; at: string }>) => ({ id: o.id ?? 'x', kind: o.kind ?? 'progress', act: o.act ?? null, status: o.status ?? null, note: o.note ?? null, createdAt: o.at ?? '2026-11-17T10:00:00Z' });

  it('says what happened, once, in order, and skips noise', () => {
    expect(announce([ev({ status: 'started', act: 'note.create' })])).toBeNull();
    const a = announce([
      ev({ id: '2', kind: 'submit', status: 'submitted', note: 'src/App.tsx: Wire new note', at: '2026-11-17T10:00:05Z' }),
      ev({ id: '1', status: 'wired', act: 'note.create', at: '2026-11-17T10:00:01Z' }),
    ])!;
    expect(a.text).toBe('Your agent wired note create. Your agent submitted a change to src/App.tsx: Wire new note. It is waiting for your approval.');
    expect(a.latest).toBe('2026-11-17T10:00:05.000Z');
  });

  it('reports blocks and guardrail stops, and trims long runs', () => {
    expect(announce([ev({ status: 'blocked', act: 'settings.email', note: 'needs the API key' })])!.text).toBe('Your agent is blocked on settings email: needs the API key');
    expect(announce([ev({ kind: 'refused', note: '.env: not a file this integration may touch' })])!.text).toMatch(/^The guardrails stopped your agent: \.env/);
    const many = Array.from({ length: 6 }, (_, i) => ev({ id: String(i), status: 'wired', act: `a${i}`, at: `2026-11-17T10:00:0${i}Z` }));
    expect(announce(many)!.text).toMatch(/And 3 more updates\.$/);
  });
});

describe('the dashboard\'s own skill', () => {
  it('stays valid and has no two acts sharing a trigger phrase', () => {
    expect(validateSkill(STUDIO_SKILL).ok).toBe(true);
    const seen = new Map<string, string>();
    for (const a of STUDIO_SKILL.acts) for (const ph of a.phrases) {
      expect(seen.get(ph), `"${ph}" is used by both ${seen.get(ph)} and ${a.name}`).toBeUndefined();
      seen.set(ph, a.name);
    }
    expect(STUDIO_SKILL.acts.find((a) => a.name === 'studio.accept')).toMatchObject({ kind: 'setting', undo: true });
  });
});
