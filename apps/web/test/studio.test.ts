import { beforeAll, describe, expect, it, vi } from 'vitest';
import { validateSkill } from '@entoli/sdk/skill';
import { memoryDb, type DB } from '@/db';
import { agentSkillFile } from '@/lib/agent-skill';
import { createApp, getUsage, meter, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import type { Chooser } from '@/lib/intent';
import { handleStudioIntent, pickFeatures, STUDIO_SKILL } from '@/lib/studio';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });

async function setup(plan: 'developer' | 'l1' | 'l2') {
  const u = await upsertUser(db, { githubId: `s${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes', repo: 'acme/fieldnotes' });
  await setPlan(db, app.id, plan, { id: 's', status: 'active' });
  return { user: u, app };
}

const wired = [
  { name: 'studio.go', slots: { tab: { type: 'choice' } } },
  { name: 'studio.approve', slots: { change: { type: 'choice', options: ['c1', 'c2'] } } },
  { name: 'studio.openPr', slots: {} },
];
const chooser = (act: string | null, slots: Record<string, string> = {}, say = 'OK.'): Chooser => vi.fn(async () => ({ choice: { act, slots, say }, usage: { tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0 }, costMicros: 140 }));

describe('the voice tool (dashboard, L2 plan)', () => {
  it('has a valid skill of its own', () => {
    expect(validateSkill(STUDIO_SKILL).ok).toBe(true);
    expect(STUDIO_SKILL.acts.find((a) => a.name === 'studio.openPr')).toMatchObject({ radius: 'external', exact: true });
  });

  it('is part of the L2 plan only', async () => {
    for (const plan of ['developer', 'l1'] as const) {
      const { user, app } = await setup(plan);
      const r = await handleStudioIntent(db, user.id, { appId: app.id, phrase: 'analyze my repo', acts: wired }, { modelAvailable: true, choose: chooser(null) });
      expect(r.status).toBe(402);
    }
  });

  it('chooses among wired dashboard acts, answers, and counts a voice-tool turn', async () => {
    const { user, app } = await setup('l2');
    const choose = chooser('studio.approve', { change: 'c2' }, 'Approving the theme change.');
    const r = await handleStudioIntent(db, user.id, { appId: app.id, phrase: 'approve the theme change', acts: wired }, { modelAvailable: true, choose });
    expect(r).toMatchObject({ status: 200, body: { act: 'studio.approve', slots: { change: 'c2' }, say: 'Approving the theme change.', toolTurns: 1 } });
    const offered = (choose as unknown as { mock: { calls: [{ acts: { name: string; slots: { name: string; options?: string[] }[] }[] }][] } }).mock.calls[0]![0].acts;
    expect(offered.map((a) => a.name)).toEqual(['studio.go', 'studio.approve', 'studio.openPr']);
    expect(offered[1]!.slots[0]).toEqual({ name: 'change', type: 'choice', options: ['c1', 'c2'] });
    expect(await getUsage(db, app.id)).toMatchObject({ toolTurns: 1, textIntents: 0, costMicros: 140 });
  });

  it('stops at the monthly quota, and is owner-only', async () => {
    const { user, app } = await setup('l2');
    await meter(db, app.id, { tool: 300 });
    const r = await handleStudioIntent(db, user.id, { appId: app.id, phrase: 'go to map', acts: wired }, { modelAvailable: true, choose: chooser(null) });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/300 voice-tool turns/);
    const stranger = await upsertUser(db, { githubId: 'stranger', login: 'x' });
    expect((await handleStudioIntent(db, stranger.id, { appId: app.id, phrase: 'go to map', acts: wired }, { modelAvailable: true })).status).toBe(404);
  });

  it('cannot be steered to an act the page did not wire', async () => {
    const { user, app } = await setup('l2');
    const r = await handleStudioIntent(db, user.id, { appId: app.id, phrase: 'publish now', acts: wired }, { modelAvailable: true, choose: chooser('studio.publish') });
    expect(r.body).toMatchObject({ act: null });
  });

  it('turns spoken feature lists into act names', () => {
    const acts = skill.acts.map((a) => ({ name: a.name, title: a.title }));
    expect(pickFeatures('new note and search', acts)).toEqual(['note.create', 'note.search']);
    expect(pickFeatures('everything', acts)).toHaveLength(acts.length);
    expect(pickFeatures('', acts)).toHaveLength(acts.length);
    expect(pickFeatures('teleportation', acts)).toEqual([]);
  });
});

describe('skill export for coding agents', () => {
  it('produces a Claude Code skill with the skill, act locations and per-act layers', async () => {
    const mixed = { ...skill, acts: skill.acts.map((a) => (a.name === 'settings.email' ? { ...a, layer: 'off' } : a)) } as never;
    const f = agentSkillFile(mixed, { 'note.create': [{ file: 'src/App.tsx', line: 61, component: 'App', handler: 'addNote' }] }, 'claude');
    expect(f.filename).toBe('SKILL.md');
    expect(f.content).toMatch(/^---\nname: entoli-integration\ndescription: .+\n---/);
    expect(f.content).toContain('`src/App.tsx:61` in `App`, handler `addNote`');
    expect(f.content).toContain("useEntoli('note.create', { text: 'freeText' }");
    expect(f.content).toContain('## Not connected (layer "off"): leave manual\n- `settings.email`');
    expect(f.content).toContain('"name": "note.create"');
    expect(agentSkillFile(mixed, {}, 'cursor').content).toMatch(/^---\ndescription: .+\nglobs:\nalwaysApply: false\n---/);
  });

  it('a published L2 skill needs the L2 plan', async () => {
    const { user, app } = await setup('l1');
    const r = await saveSkill(db, user.id, app.id, skill, 'published');
    expect(r.ok).toBe(false);
    const l1 = { ...skill, layer: 'L1' };
    expect((await saveSkill(db, user.id, app.id, l1, 'published')).ok).toBe(true);
  });
});
