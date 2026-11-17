import { beforeAll, describe, expect, it } from 'vitest';
import { Entoli, startLive, type LiveHandlers, type LiveProvider } from '@entoli/sdk';
import { actLayer, type Skill } from '@entoli/sdk/skill';
import { memoryDb, type DB } from '@/db';
import { createApp, getApp, saveSkill, setPlan, skillOf, upsertUser } from '@/lib/apps';
import { acceptProposal, explain, proposalOf, proposeFor, undoProposal } from '@/lib/proposal';
import { STUDIO_SKILL } from '@/lib/studio-skill';
import raw from '../../../examples/notes-app/entoli.skill.json';

const skill = raw as unknown as Skill;
let db: DB;
beforeAll(async () => { db = await memoryDb(); });

class Clock {
  t = 1_000_000; q: { at: number; fn: () => void; id: number }[] = []; n = 0;
  now() { return this.t; }
  set(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; }
  clear(id: unknown) { this.q = this.q.filter((x) => x.id !== id); }
  async advance(ms: number) { this.t += ms; const due = this.q.filter((x) => x.at <= this.t); this.q = this.q.filter((x) => x.at > this.t); due.forEach((d) => d.fn()); await new Promise((r) => setTimeout(r, 10)); }
}

/** The dashboard's bar, wired the way StudioBar wires it (same acts, same handlers, same words), but calling the library directly. */
async function dashboard() {
  const u = await upsertUser(db, { githubId: `c${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
  await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
  expect((await saveSkill(db, u.id, app.id, skill, 'draft')).ok).toBe(true);
  const get = async () => (await getApp(db, u.id, app.id))!;

  const clock = new Clock();
  const e = new Entoli({ skill: STUDIO_SKILL, timers: clock, layer: 'L1' });
  const acts = async () => (skillOf(await get())?.acts ?? []).map((a) => ({ value: a.name, label: a.title ?? a.name, aliases: [a.name] }));
  const options = (await acts());
  e.register('studio.propose', {}, async () => proposeFor(db, await get()), { readOnly: true, describe: () => 'Proposal ready', say: (r) => (r as { spoken: string }).spoken });
  e.register('studio.accept', {}, async () => acceptProposal(db, await get()), { undo: async () => undoProposal(db, await get()), describe: () => 'Accepted the proposal', say: (r) => `Done. I changed ${(r as { changed: number }).changed} features. You can say undo, or move any of them yourself.` });
  e.register('studio.why', { act: { type: 'choice', options } }, async ({ act }) => explain(proposalOf(await get())!, String(act)), { readOnly: true, say: (r) => String(r), describe: ({ act }) => `Why ${String(act)}` });

  let h!: LiveHandlers;
  const said: string[] = [];
  const provider: LiveProvider = { name: 'fake', async start(x) { h = x; }, say: (t) => said.push(t), interrupt() {}, setMuted() {}, stop() {} };
  await startLive(e, provider, { timers: clock });
  const hear = async (t: string) => { h.onTranscript(t); await new Promise((r) => setTimeout(r, 30)); await clock.advance(1700); await clock.advance(50); };
  return { hear, said, get, state: () => e.state };
}

describe('the proposal, spoken start to finish', () => {
  it('"what should I expose?" → the AI-free device understands it, Entoli speaks the proposal, the developer asks why, accepts with a yes, and the skill ends up with per-act layers', async () => {
    const d = await dashboard();
    const before = skillOf(await d.get())!;

    await d.hear('what should I expose');
    const proposal = d.said.at(-1)!;
    expect(proposal).toMatch(/^I found 8 features\. I would hand New note, Search notes and Change font size to the AI/);
    expect(proposal).toMatch(/Say accept to apply it/);

    await d.hear('why is change email manual');
    expect(d.said.at(-1)).toMatch(/^Change email: I would put it on kept manual\. It reaches outside the app/);

    // Accepting changes what the AI can reach, so it is a setting: it asks, and nothing changes without a yes.
    await d.hear('accept the proposal');
    expect(d.said.at(-1)).toMatch(/Say yes to go ahead, or no\.$/);
    expect(skillOf(await d.get())!.acts.map((a) => a.layer)).toEqual(before.acts.map((a) => a.layer));

    await d.hear('yes');
    expect(d.said.at(-1)).toMatch(/^Done\. I changed 5 features\./);
    const after = skillOf(await d.get())!;
    const layer = (n: string) => actLayer(after, after.acts.find((a) => a.name === n)!);
    expect([layer('note.create'), layer('note.tag'), layer('nav.open'), layer('settings.email')]).toEqual(['L2', 'L1', 'L1', 'off']);
    expect(proposalOf(await d.get())!.applied).toBeTruthy();
  });

  it('"no" leaves everything as it was', async () => {
    const d = await dashboard();
    const before = skillOf(await d.get())!;
    await d.hear('what should I expose');
    await d.hear('accept the proposal');
    await d.hear('no');
    expect(skillOf(await d.get())!.acts.map((a) => a.layer)).toEqual(before.acts.map((a) => a.layer));
    expect(proposalOf(await d.get())!.applied).toBeUndefined();
  });
});
