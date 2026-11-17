/**
 * "What should Entoli take over?": the proposal conversation.
 *
 * After the app has been read, every act gets a recommendation with a reason in
 * plain words:
 *
 *   L2   the AI answers: acts where one sentence replaces several clicks
 *        (several details, free text, a time, a person) and that can be undone
 *   L1   the device answers, no AI: short, predictable acts (open a screen,
 *        switch a theme) that the device understands instantly, at no cost
 *   off  keep it manual: acts that reach outside the app, or cannot be undone
 *        and look destructive (pay, delete, publish, passwords). They can still
 *        be exposed later; they would always ask for an exact yes
 *
 * Deterministic on purpose: the same skill gives the same proposal, the reasons
 * are checkable, and nothing here can invent an act.
 */
import { actLayer, type ActLayer, type Skill, type SkillAct } from '@entoli/sdk/skill';

export type Recommendation = {
  act: string;
  title: string;
  current: ActLayer;
  recommend: ActLayer;
  reason: string;
  /** Does applying the proposal change this act's layer? */
  change: boolean;
};

export type Proposal = {
  items: Recommendation[];
  spoken: string;
  createdAt: string;
  /** The layers each act had before the proposal was accepted, so it can be undone. */
  applied?: Record<string, ActLayer | null>;
};

const RISKY_WORDS = /\b(delete|remove|destroy|erase|wipe|pay|payment|purchase|buy|checkout|publish|deploy|transfer|withdraw|password|billing|subscription|close account|sign ?out|log ?out)\b/i;
const NAV = /^(nav|navigate|go|open|show)[.\-_ ]|\bgo to\b|\bopen the\b/i;

const words = (a: SkillAct) => `${a.name} ${a.title ?? ''} ${a.phrases.join(' ')}`;

function judge(skill: Skill, a: SkillAct): { recommend: ActLayer; reason: string } {
  const slots = Object.values(a.slots ?? {});
  const kinds = new Set(slots.map((s) => s.type));
  const rich = slots.length >= 2 || kinds.has('freeText') || kinds.has('when') || kinds.has('person') || kinds.has('quantity');
  const choiceOnly = slots.length > 0 && slots.every((s) => s.type === 'choice');

  if (a.radius === 'external') {
    return { recommend: 'off', reason: 'It reaches outside the app, so I would keep it manual. If you do expose it, it will always show exactly what will run and wait for a yes.' };
  }
  if (!a.undo && RISKY_WORDS.test(words(a))) {
    return { recommend: 'off', reason: 'It cannot be undone and it looks destructive, so I would keep it manual. Exposed later, it would always ask for a yes.' };
  }
  if (NAV.test(words(a)) && !rich) {
    return { recommend: 'L1', reason: 'Opening a screen is short and predictable: the device understands it instantly, with no AI and no cost.' };
  }
  if (a.radius === 'other-person') {
    return rich
      ? { recommend: 'L2', reason: 'It affects another person and takes details from a sentence, so the AI helps fill them in. It always asks for a yes first.' }
      : { recommend: 'L1', reason: 'It affects another person, so keep it simple and on the device. It asks for a yes either way.' };
  }
  if (!slots.length || choiceOnly) {
    return { recommend: 'L1', reason: `${slots.length ? 'A choice between a few options' : 'A single step'}: the device understands it instantly, with no AI and no cost.` };
  }
  if (rich && a.undo) {
    return { recommend: 'L2', reason: 'Here one spoken sentence replaces several clicks (details, free text, a time or a person), and it can be undone. This is where the AI saves people the most effort.' };
  }
  return { recommend: skill.layer, reason: 'No strong signal either way, so I would leave it as it is.' };
}

const layerName = (l: ActLayer) => (l === 'L2' ? 'Layer 2, where the AI answers' : l === 'L1' ? 'Layer 1, on the device' : 'kept manual');

export function buildProposal(skill: Skill, now = new Date()): Proposal {
  const items: Recommendation[] = skill.acts.map((a) => {
    const current = actLayer(skill, a);
    const j = judge(skill, a);
    return { act: a.name, title: a.title ?? a.name, current, recommend: j.recommend, reason: j.reason, change: j.recommend !== current };
  });
  return { items, spoken: script(items), createdAt: now.toISOString() };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const some = (xs: Recommendation[], n = 3) => (xs.length > n ? `${xs.slice(0, n).map((x) => x.title).join(', ')} and ${xs.length - n} more` : list(xs.map((x) => x.title)));

export function script(items: Recommendation[]): string {
  if (!items.length) return 'I did not find anything to expose yet. Analyze your repository first.';
  const g = (l: ActLayer) => items.filter((i) => i.recommend === l);
  const [ai, device, manual] = [g('L2'), g('L1'), g('off')];
  const parts = [`I found ${items.length} features.`];
  if (ai.length) parts.push(`I would hand ${some(ai)} to the AI, because one sentence saves several clicks.`);
  if (device.length) parts.push(`I would keep ${some(device)} on the device: they are short and need no AI.`);
  if (manual.length) parts.push(`And I would leave ${some(manual)} manual, because they reach outside the app or cannot be undone.`);
  const changes = items.filter((i) => i.change).length;
  parts.push(changes ? `That changes ${changes}. Say accept to apply it, or ask why about any of them.` : 'That matches how things are already set. Ask why about any of them if you like.');
  return parts.join(' ');
}

/** The answer to "why is X manual?". */
export function explain(p: Proposal, act: string): string {
  const i = p.items.find((x) => x.act === act);
  if (!i) return 'I do not have a recommendation for that one.';
  return `${i.title}: I would put it on ${layerName(i.recommend)}. ${i.reason}`;
}

/** The skill with the proposal applied. Acts already at the recommended layer are left alone; a layer equal to the app's is stored as "inherit". */
export function applyProposal(skill: Skill, p: Proposal): { skill: Skill; applied: Record<string, ActLayer | null> } {
  const applied: Record<string, ActLayer | null> = {};
  const rec = new Map(p.items.filter((i) => i.change).map((i) => [i.act, i.recommend]));
  const acts = skill.acts.map((a) => {
    const r = rec.get(a.name);
    if (!r) return a;
    applied[a.name] = a.layer ?? null;
    const { layer: _drop, ...rest } = a;
    void _drop;
    return r === skill.layer ? rest : { ...rest, layer: r };
  });
  return { skill: { ...skill, acts }, applied };
}

/** Put every layer back the way it was before the proposal was applied. */
export function revertProposal(skill: Skill, applied: Record<string, ActLayer | null>): Skill {
  return {
    ...skill,
    acts: skill.acts.map((a) => {
      if (!(a.name in applied)) return a;
      const prev = applied[a.name];
      const { layer: _drop, ...rest } = a;
      void _drop;
      return prev ? { ...rest, layer: prev } : rest;
    }),
  };
}

// ---- persistence -----------------------------------------------------------------------------

import { eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { apps } from '@/db/schema';
import { saveSkill, skillOf } from './apps';
import { PLANS } from './plans';

type AppRow = typeof apps.$inferSelect;

export const proposalOf = (app: AppRow): Proposal | null => (app.proposal as Proposal | null) ?? null;

export async function proposeFor(db: DB, app: AppRow): Promise<Proposal> {
  if (!PLANS[app.plan].integration) throw new Error('The proposal conversation is part of the L2 plan.');
  const skill = skillOf(app);
  if (!skill) throw new Error('Analyze the repository first, so there is something to propose.');
  const p = buildProposal(skill);
  await db.update(apps).set({ proposal: p }).where(eq(apps.id, app.id));
  return p;
}

export async function acceptProposal(db: DB, app: AppRow): Promise<{ changed: number }> {
  const p = proposalOf(app);
  const skill = skillOf(app);
  if (!p || !skill) throw new Error('There is no proposal to accept. Ask me what to expose first.');
  if (p.applied) throw new Error('That proposal is already applied.');
  const { skill: next, applied } = applyProposal(skill, p);
  const r = await saveSkill(db, app.ownerId, app.id, next, app.skillStatus === 'published' ? 'published' : 'draft');
  if (!r.ok) throw new Error(r.errors.join(' '));
  await db.update(apps).set({ proposal: { ...p, applied } }).where(eq(apps.id, app.id));
  return { changed: Object.keys(applied).length };
}

export async function undoProposal(db: DB, app: AppRow): Promise<void> {
  const p = proposalOf(app);
  const skill = skillOf(app);
  if (!p?.applied || !skill) return;
  await saveSkill(db, app.ownerId, app.id, revertProposal(skill, p.applied), app.skillStatus === 'published' ? 'published' : 'draft');
  const { applied: _gone, ...rest } = p;
  void _gone;
  await db.update(apps).set({ proposal: rest }).where(eq(apps.id, app.id));
}
