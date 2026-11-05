/**
 * The Claude pass: improves the static draft (natural phrases, slot prompts,
 * radius/undo judgement, what the app can and cannot do).
 *
 * The model cannot add capability. Every act it returns must cite the ids of
 * controls the static pass found in the code, or it is dropped; contract
 * fields merge stricter-wins with the static guess; the result must pass the
 * skill validator or the static draft is kept.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { RADII, SLOT_TYPES, validateSkill, type KnowledgeEntry, type Radius, type Skill, type SkillAct, type SkillSlot } from '@entoli/sdk/skill';
import { askJson, AiError, type Usage } from './ai.js';
import type { Draft } from './draft.js';
import type { ScanResult } from './scan.js';

type AiSlot = { name: string; type: (typeof SLOT_TYPES)[number]; required: boolean; label: string; prompt: string; options: string[] };
type AiAct = {
  name: string; title: string; source_controls: string[]; phrases: string[]; radius: Radius; undo: boolean; exact: boolean;
  voice_only: boolean; is_setting: boolean; reason: string; slots: AiSlot[];
};
type AiOut = {
  screens: { id: string; title: string }[];
  acts: AiAct[];
  knowledge: { topic: string; can: boolean; answer: string; phrases: string[]; evidence: string }[];
  notes: string[];
};

const str = { type: 'string' } as const;
const strs = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const REFINE_SCHEMA = obj({
  screens: { type: 'array', items: obj({ id: str, title: str }) },
  acts: {
    type: 'array',
    items: obj({
      name: str, title: str, source_controls: strs, phrases: strs, radius: { type: 'string', enum: [...RADII] },
      undo: { type: 'boolean' }, exact: { type: 'boolean' }, voice_only: { type: 'boolean' }, is_setting: { type: 'boolean' }, reason: str,
      slots: { type: 'array', items: obj({ name: str, type: { type: 'string', enum: [...SLOT_TYPES] }, required: { type: 'boolean' }, label: str, prompt: str, options: strs }) },
    }),
  },
  knowledge: { type: 'array', items: obj({ topic: str, can: { type: 'boolean' }, answer: str, phrases: strs, evidence: str }) },
  notes: strs,
});

const SYSTEM = `You help developers make their app operable by intent with Entoli. You receive what a static scan found in an app's source code (screens, and controls such as buttons, forms and settings, each with an id) and a draft skill made from it. Return an improved skill.

Rules that matter for safety:
- Every act must correspond to real controls from the scan. List their ids in source_controls. Do not add capabilities the code does not show.
- radius: "self" when only this user's own data or view changes; "other-person" when it reaches another person (sharing, inviting, messaging, assigning); "external" when it reaches outside the app or the account (payments, publishing, email/password changes, third-party calls).
- undo: true only if the app could plausibly take the act back (create, edit, toggle, move). Deletes, sends, payments: false.
- exact: true for anything external or where the exact arguments matter (addresses, amounts).
- is_setting: true for acts that change how the app behaves (theme, language, notifications, account details). Settings are changed by voice only, with a yes.
- Phrases: 2 to 5 short ways a person would ask, in their words, lowercase.
- Slot types are a closed set: choice, quantity, when, person, freeText. Use choice options only from values visible in the scan.
- Knowledge: what a user might ask the app can or can't do. "can": true entries must map to acts; "can": false entries only for things users commonly expect from this kind of app that the code clearly lacks. Give the evidence for each.
- Act names: lowercase start, letters/digits/dots, e.g. note.create.
Use empty strings and empty arrays for anything that does not apply.`;

/** Cap on the scan summary sent to the model, in characters (≈ tokens × 3.5). */
export function summarize(scan: ScanResult, draft: Draft, maxInputTokens: number): { text: string; omitted: number } {
  const ordered = [...scan.controls].sort((a, b) => Number(!!b.handler) - Number(!!a.handler) || Number(b.kind !== 'link') - Number(a.kind !== 'link'));
  const compact = (c: (typeof ordered)[number]) => ({
    id: c.id, kind: c.kind, label: c.label, ...(c.handler ? { handler: c.handler } : {}), ...(c.href ? { href: c.href } : {}),
    screen: c.screen, ...(c.setting ? { setting: true } : {}), at: `${c.file}:${c.line}`,
    ...(c.fields?.length ? { fields: c.fields.map((f) => ({ name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })) } : {}),
  });
  const budget = Math.max(4000, Math.floor(maxInputTokens * 3.5));
  const head = { app: scan.appName, frameworks: scan.frameworks, screens: scan.screens.map((s) => ({ id: s.id, path: s.path, title: s.title })) };
  const draftActs = draft.skill.acts.map((a) => ({ name: a.name, radius: a.radius, undo: !!a.undo, phrases: a.phrases, slots: Object.keys(a.slots ?? {}) }));
  let controls = ordered.map(compact);
  let omitted = 0;
  let text = JSON.stringify({ ...head, controls, draftActs });
  while (text.length > budget && controls.length > 1) {
    const cut = Math.max(1, Math.floor(controls.length * 0.1));
    omitted += cut;
    controls = controls.slice(0, controls.length - cut);
    text = JSON.stringify({ ...head, controls, draftActs, omittedControls: omitted });
  }
  return { text, omitted };
}

const RANK: Record<Radius, number> = { self: 0, 'other-person': 1, external: 2 };
const NAME = /^[a-z][a-zA-Z0-9_.-]*$/;
const SLOT = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export type RefineResult = { skill: Skill; usage: Usage; costMicros: number; model: string; dropped: string[]; notes: string[]; omitted: number; sources: Draft['sources'] };

export async function refineWithClaude(scan: ScanResult, draft: Draft, opts: { maxInputTokens?: number; maxOutputTokens?: number; model?: string; client?: Anthropic } = {}): Promise<RefineResult> {
  const { text, omitted } = summarize(scan, draft, opts.maxInputTokens ?? 60_000);
  const r = await askJson<AiOut>({
    system: SYSTEM,
    prompt: `Scan of the app's source code:\n${text}`,
    schema: REFINE_SCHEMA,
    effort: 'medium',
    maxTokens: opts.maxOutputTokens ?? 32_000,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.client ? { client: opts.client } : {}),
  });
  const merged = mergeRefinement(scan, draft, r.data);
  const v = validateSkill(merged.skill);
  if (!v.ok) throw new AiError(`The refined skill did not validate: ${v.errors.slice(0, 3).join('; ')}`, 'invalid_json', r.usage, r.model);
  return { skill: v.skill, usage: r.usage, costMicros: r.costMicros, model: r.model, dropped: merged.dropped, notes: [...r.data.notes, ...merged.notes], omitted, sources: merged.sources };
}

/** Pure merge, exported for tests. */
export function mergeRefinement(scan: ScanResult, draft: Draft, ai: AiOut): { skill: Skill; dropped: string[]; notes: string[]; sources: Draft['sources'] } {
  const dropped: string[] = [];
  const notes: string[] = [];
  const controls = new Map(scan.controls.map((c) => [c.id, c]));
  const staticByControl = new Map<string, SkillAct>();
  const nodeByControl = new Map<string, string>();
  for (const n of draft.skill.map) {
    const cid = n.id.split('.').pop()!;
    if (controls.has(cid) && n.act) {
      const a = draft.skill.acts.find((x) => x.name === n.act);
      if (a) staticByControl.set(cid, a);
      nodeByControl.set(cid, n.id);
    }
  }

  const acts = new Map<string, SkillAct>();
  const actSources: Draft['sources'] = {};
  const renamed = new Map<string, string>(); // map node id -> act name
  for (const a of ai.acts) {
    const sources = a.source_controls.filter((id) => controls.has(id));
    if (sources.length === 0 || !NAME.test(a.name)) { dropped.push(a.name || '(unnamed)'); continue; }
    if (acts.has(a.name)) { dropped.push(`${a.name} (duplicate)`); continue; }
    const statics = sources.map((id) => staticByControl.get(id)).filter((x): x is SkillAct => !!x);
    const staticRadius = statics.reduce<Radius>((m, s) => (RANK[s.radius] > RANK[m] ? s.radius : m), 'self');
    const radius = RANK[a.radius] >= RANK[staticRadius] ? a.radius : staticRadius;
    const anyControlSetting = sources.some((id) => controls.get(id)!.setting);
    const setting = a.is_setting || anyControlSetting || statics.some((s) => s.kind === 'setting');
    const codeOptions = sources.flatMap((id) => [...(controls.get(id)!.options ?? []), ...(controls.get(id)!.fields ?? []).flatMap((f) => f.options ?? [])]);

    const slots: Record<string, SkillSlot> = {};
    for (const s of a.slots) {
      if (!SLOT.test(s.name) || !(SLOT_TYPES as readonly string[]).includes(s.type)) continue;
      const slot: SkillSlot = { type: s.type };
      if (s.required) slot.required = true;
      if (s.label) slot.label = s.label;
      if (s.prompt) slot.prompt = s.prompt;
      if ((s.type === 'choice' || s.type === 'person') && s.options.length) {
        const opts = codeOptions.length ? s.options.filter((o) => codeOptions.includes(o)) : s.options;
        if (opts.length) slot.options = [...new Set(opts)];
      }
      slots[s.name] = slot;
    }

    const act: SkillAct = { name: a.name, title: a.title || a.name, phrases: [...new Set(a.phrases.map((p) => p.trim().toLowerCase()).filter(Boolean))].slice(0, 6), radius, slots };
    if (act.phrases.length === 0) act.phrases = statics[0]?.phrases ?? [a.name];
    // Stricter wins: undo only if both agree; exact and voice-only if either says so.
    const staticUndo = statics.length === 0 || statics.every((s) => s.undo === true);
    if (a.undo && staticUndo) act.undo = true;
    if (a.exact || radius === 'external' || statics.some((s) => s.exact)) act.exact = true;
    if (setting) { act.kind = 'setting'; act.voiceOnly = true; }
    else if (a.voice_only || statics.some((s) => s.voiceOnly)) act.voiceOnly = true;
    const screen = statics.find((s) => s.screen)?.screen;
    if (screen) act.screen = screen;
    acts.set(act.name, act);
    actSources[act.name] = sources.map((id) => { const c = controls.get(id)!; return { file: c.file, line: c.line, ...(c.component ? { component: c.component } : {}), ...(c.handler ? { handler: c.handler } : {}) }; });
    for (const id of sources) { const nid = nodeByControl.get(id); if (nid) renamed.set(nid, act.name); }
  }
  // Navigation is structural; it survives whatever the model does.
  const nav = draft.skill.acts.find((a) => a.name === 'nav.open');
  if (nav && !acts.has('nav.open')) acts.set('nav.open', nav);
  if (draft.sources['nav.open'] && !actSources['nav.open']) actSources['nav.open'] = draft.sources['nav.open'];

  const titles = new Map(ai.screens.filter((s) => s.title).map((s) => [s.id, s.title]));
  const map = draft.skill.map.map((n) => {
    const out = { ...n };
    if (n.kind === 'screen' && titles.has(n.id)) out.title = titles.get(n.id)!;
    if (n.act) {
      const next = renamed.get(n.id) ?? (acts.has(n.act) ? n.act : undefined);
      if (next) out.act = next; else delete out.act;
    }
    return out;
  });

  const actNames = new Set(acts.keys());
  const knowledge: KnowledgeEntry[] = [];
  for (const k of ai.knowledge) {
    if (!k.topic || !k.answer || !k.evidence) { dropped.push(`knowledge "${k.topic}" (no evidence)`); continue; }
    const e: KnowledgeEntry = { topic: k.topic, can: k.can, answer: k.answer };
    if (k.phrases.length) e.phrases = k.phrases.slice(0, 5);
    knowledge.push(e);
  }
  if (!knowledge.length) knowledge.push(...draft.skill.knowledge.filter((k) => actNames.size > 0 || !k.can));

  const skill: Skill = { ...draft.skill, map, acts: [...acts.values()], knowledge };
  return { skill, dropped, notes, sources: actSources };
}
