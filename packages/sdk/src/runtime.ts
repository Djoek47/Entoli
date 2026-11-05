/**
 * The Entoli runtime: phrase in, one card out, commit under the contract.
 *
 *   1. a question about the app        → answered from skill.knowledge only
 *   2. on device (tacit's tier-0 matcher, no network) → act + slots
 *   3. unresolved and a key is set     → /api/intent, which may only CHOOSE
 *                                        among declared acts; never invent one
 *   4. the contract decides: hold 1.6 s, a yes, or "Do exactly this"
 *
 * One card at a time. Every state has a way out.
 */

import { HOLD_MS, fingerprint, planCommit, type Channel, type CommitPlan } from './contract.js';
import type { ActDef, Candidate, Ctx, Option, SlotDef } from './engine/core-types.js';
import { remainder } from './engine/free.js';
import { resolveQuantity, resolveWhen } from './engine/grammar.js';
import { LocalResolver } from './engine/local.js';
import { pickAct } from './engine/route.js';
import { matchPhrase, tokenize } from './engine/text.js';
import { answerFrom, isKnowledgeQuestion, NO_KNOWLEDGE } from './knowledge.js';
import { actLayer, optionValue, type ActLayer, type ChoiceOption, type Layer, type Mode, type Radius, type Skill, type SkillAct, type SkillSlot, type SlotType } from './skill.js';

export type RuntimeSlot = Omit<SkillSlot, 'options'> & { options?: ChoiceOption[] | (() => ChoiceOption[]) };
export type SlotsSpec = Record<string, RuntimeSlot | SlotType>;

export type ActHandler = (slots: Record<string, unknown>, info: { channel: Channel; act: string }) => unknown;

export type ActOptions = {
  /** Takes the act back. Without it the act can never run on silence. */
  undo?: (result: unknown, slots: Record<string, unknown>) => unknown;
  voiceOnly?: boolean;
  exact?: boolean;
  radius?: Radius;
  kind?: 'feature' | 'setting';
  title?: string;
  /** Extra trigger phrases, added to the skill's. */
  phrases?: string[];
  /** One line for the receipt. Defaults to the title and arguments. */
  describe?: (slots: Record<string, unknown>) => string;
  /**
   * Normalise and check the slots BEFORE the card is drawn, so the card shows
   * exactly what will run. Return new slots, or a string to refuse (shown to
   * the person; nothing runs).
   */
  prepare?: (slots: Record<string, unknown>) => Record<string, unknown> | string;
};

export type Arg = { name: string; label: string; value: unknown; display: string };

export type Receipt = {
  id: string;
  act: string;
  title: string;
  summary: string;
  at: number;
  undoable: boolean;
  undone?: boolean;
};

export type Phase =
  | 'idle' | 'thinking' | 'ask' | 'narrow' | 'hold' | 'confirm' | 'exact'
  | 'blocked' | 'answer' | 'none' | 'running' | 'done' | 'error';

export type StageState = {
  phase: Phase;
  said?: string;
  channel?: Channel;
  act?: string;
  title?: string;
  args?: Arg[];
  why?: string;
  holdMs?: number;
  holdEndsAt?: number;
  fingerprint?: string;
  message?: string;
  can?: boolean | null;
  ask?: { slot: string; prompt: string; options?: string[] };
  choices?: { act: string; title: string }[];
  /** Where the act was understood: on device or by the model. */
  via?: 'device' | 'model';
  /** Layer 2: what the AI said back (shown above the card, spoken in voice mode). */
  reply?: string;
  receipts: Receipt[];
};

export type RemoteRequest = {
  phrase: string;
  channel: Channel;
  layer: Layer;
  /** The act the device matched, if any: the AI can confirm it cheaply. */
  hint?: string;
  acts: { name: string; title: string; phrases: string[]; slots: Record<string, { type: SlotType; options?: string[] }> }[];
};
/** What the AI (or a developer's own resolver) answers: an act from the skill or none, and, on Layer 2, what to say. */
export type RemoteChoice = { act: string | null; slots?: Record<string, unknown>; say?: string } | null;
export type RemoteResolver = (req: RemoteRequest) => Promise<RemoteChoice>;

export type Timers = {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
};

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type EntoliOptions = {
  skill: Skill;
  /** Public app key (ek_live_… / ek_test_…). Enables the model fallback. */
  key?: string;
  /** Where /api/intent lives. Defaults to https://entoli.dev */
  endpoint?: string;
  mode?: Mode;
  /** Override the skill's layer. */
  layer?: Layer;
  /**
   * Your own AI ("bring your own"): asked on Layer 1 for phrases the device did
   * not understand, and on Layer 2 in place of Entoli's AI. It may only choose
   * among declared acts, like Entoli's.
   */
  resolver?: RemoteResolver;
  timers?: Timers;
  fetch?: typeof fetch;
  /**
   * 'contract' (default): self + undo runs after the 1.6 s hold.
   * 'always': every act waits for an explicit yes. Can only make things stricter.
   */
  confirm?: 'contract' | 'always';
};

type Registered = {
  name: string;
  title: string;
  phrases: string[];
  slots: Record<string, RuntimeSlot>;
  radius: Radius;
  undoFn?: ActOptions['undo'];
  voiceOnly: boolean;
  exact: boolean;
  kind: 'feature' | 'setting';
  declared: boolean;
  /** Effective layer: 'L2' the AI may pick it, 'L1' device only. ('off' acts are never registered.) */
  layer: Exclude<ActLayer, 'off'>;
  handler: ActHandler;
  describe?: ActOptions['describe'];
  prepare?: ActOptions['prepare'];
};

type Pending = {
  reg: Registered;
  values: Record<string, unknown>;
  labels: Record<string, string>;
  via: 'device' | 'model';
  said: string;
  channel: Channel;
  reply?: string;
};

const RANK: Record<Radius, number> = { self: 0, 'other-person': 1, external: 2 };
const YES = /^(yes|yeah|yep|sure|ok|okay|do it|confirm|go ahead|go|yes please|do exactly this)$/;
const NO = /^(no|nope|cancel|stop|not that|never mind|nevermind|don t)$/;

let seq = 0;
const uid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

function slotSpec(s: RuntimeSlot | SlotType): RuntimeSlot {
  return typeof s === 'string' ? { type: s } : s;
}

function optionsOf(s: RuntimeSlot): Option[] {
  const raw = typeof s.options === 'function' ? s.options() : s.options ?? [];
  return raw.map((o) => {
    const v = optionValue(o);
    return { value: v.value, label: v.label, aliases: v.aliases };
  });
}

function display(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'label' in (v as object)) return String((v as { label: unknown }).label);
  return String(v);
}

function humanize(name: string): string {
  const s = name.replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class Entoli {
  readonly skill: Skill;
  readonly mode: Mode;
  /** L1: the device answers (menu responds). L2: Entoli's AI answers, then the change goes on the card. */
  readonly layer: Layer;
  private readonly confirmMode: 'contract' | 'always';
  private readonly key?: string;
  private readonly remote?: RemoteResolver;
  /** A developer's own resolver on a Layer 1 app: asked only when the device did not understand. */
  private readonly byo: boolean;
  private readonly timers: Timers;
  private readonly acts = new Map<string, Registered>();
  private readonly listeners = new Set<(s: StageState) => void>();
  private readonly undoers = new Map<string, () => unknown>();
  private readonly local = new LocalResolver();
  private pending: Pending | null = null;
  private holdTimer: unknown = null;
  private narrowText = '';
  private _state: StageState = { phase: 'idle', receipts: [] };
  /** Counts for the developer: how much resolved on device. */
  readonly stats = { device: 0, model: 0, knowledge: 0, unresolved: 0 };

  constructor(opts: EntoliOptions) {
    this.skill = opts.skill;
    this.mode = opts.mode ?? opts.skill.mode;
    this.confirmMode = opts.confirm ?? 'contract';
    if (opts.key !== undefined) this.key = opts.key;
    this.timers = opts.timers ?? realTimers;
    this.layer = opts.layer ?? opts.skill.layer;
    // Layer 1: no Entoli AI. Only a resolver the developer brings is ever asked.
    // Layer 2: Entoli's AI (with the app key), or the developer's own resolver.
    if (opts.resolver) this.remote = opts.resolver;
    else if (opts.key && (this.layer === 'L2' || opts.skill.acts.some((a) => a.layer === 'L2'))) this.remote = httpResolver(opts.endpoint ?? 'https://entoli.dev', opts.key, opts.fetch);
    this.byo = !!opts.resolver && this.layer === 'L1' && !opts.skill.acts.some((a) => a.layer === 'L2');
  }

  get state(): StageState {
    return this._state;
  }

  get hasKey(): boolean {
    return !!this.key;
  }

  subscribe(fn: (s: StageState) => void): () => void {
    this.listeners.add(fn);
    fn(this._state);
    return () => this.listeners.delete(fn);
  }

  private set(next: Omit<StageState, 'receipts'> & { receipts?: Receipt[] }): void {
    this._state = { ...next, receipts: next.receipts ?? this._state.receipts };
    for (const l of this.listeners) l(this._state);
  }

  /**
   * Wire an act to the app's real function. The skill's declaration and the
   * code's options are merged STRICTER-WINS: the larger radius, voiceOnly or
   * exact if either says so, and undo only when an undo function exists.
   */
  register(name: string, slots: SlotsSpec, handler: ActHandler, opts: ActOptions = {}): () => void {
    const declared = this.skill.acts.find((a) => a.name === name);
    const layer = declared ? actLayer({ layer: this.layer }, declared) : this.layer;
    if (layer === 'off') {
      // Declared but not connected: the developer chose to keep it manual.
      return () => {};
    }
    const skillSlots = declared?.slots ?? {};
    const merged: Record<string, RuntimeSlot> = {};
    for (const [k, v] of Object.entries(skillSlots)) merged[k] = { ...v };
    for (const [k, v] of Object.entries(slots)) merged[k] = { ...(merged[k] ?? {}), ...slotSpec(v) };

    const radius = [declared?.radius, opts.radius].filter((r): r is Radius => !!r)
      .reduce<Radius>((a, b) => (RANK[b] > RANK[a] ? b : a), 'self');
    if (!declared && !opts.radius) {
      // Undeclared and no radius from code either: assume the worst.
      console.warn(`[entoli] act "${name}" is not in the skill and has no radius; treating it as external`);
    }
    const reg: Registered = {
      name,
      title: opts.title ?? declared?.title ?? humanize(name),
      phrases: [...(declared?.phrases ?? []), ...(opts.phrases ?? [])],
      slots: merged,
      radius: !declared && !opts.radius ? 'external' : radius,
      voiceOnly: !!(declared?.voiceOnly || opts.voiceOnly),
      exact: !!(declared?.exact || opts.exact),
      kind: declared?.kind === 'setting' || opts.kind === 'setting' ? 'setting' : 'feature',
      declared: !!declared,
      layer,
      handler,
    };
    if (opts.undo && declared?.undo !== false) reg.undoFn = opts.undo;
    if (opts.describe) reg.describe = opts.describe;
    if (opts.prepare) reg.prepare = opts.prepare;
    if (reg.phrases.length === 0) reg.phrases.push(humanize(name).toLowerCase());
    this.acts.set(name, reg);
    return () => {
      if (this.acts.get(name) === reg) this.acts.delete(name);
    };
  }

  registered(): string[] {
    return [...this.acts.keys()];
  }

  /** Acts declared in the skill that no code has wired. */
  unwired(): SkillAct[] {
    return this.skill.acts.filter((a) => !this.acts.has(a.name));
  }

  private ctx(): Ctx {
    return {
      now: new Date(this.timers.now()),
      actor: { id: 'me' },
      attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
    };
  }

  private toActDef(r: Registered): ActDef {
    const slots: Record<string, SlotDef> = {};
    let order = 0;
    for (const [name, s] of Object.entries(r.slots)) {
      const base = { order: order++, required: !!s.required };
      if (s.type === 'choice' || s.type === 'person') {
        slots[name] = { ...base, primitive: 'chip', options: () => optionsOf(s) };
      } else if (s.type === 'quantity') {
        slots[name] = { ...base, primitive: 'quantity', resolve: (t) => resolveQuantity(t) };
      } else if (s.type === 'when') {
        slots[name] = { ...base, primitive: 'when', resolve: (t, c) => resolveWhen(t, c) };
      } else {
        const rest = remainder(r.phrases);
        // ghostField: the matcher leaves free text out of routing evidence.
        slots[name] = { ...base, primitive: 'ghostField', resolve: (t) => rest(t) };
      }
    }
    return { name: r.name, phrases: r.phrases, slots, radius: r.radius, commit: () => ({ id: r.name }) };
  }

  private optionsFor = (act: ActDef, slot: string): Option[] => {
    const r = this.acts.get(act.name);
    const s = r?.slots[slot];
    return s && (s.type === 'choice' || s.type === 'person') ? optionsOf(s) : [];
  };

  /** Say or type something, as the person. */
  async hear(text: string, opts: { channel?: Channel } = {}): Promise<StageState> {
    const said = text.trim();
    const channel: Channel = opts.channel ?? 'text';
    if (!said) return this._state;
    const low = said.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

    // A yes or a no answers the card on the stage, if one is waiting.
    const ph = this._state.phase;
    if (ph === 'hold' || ph === 'confirm' || ph === 'exact') {
      if (YES.test(low)) { await this.confirm(this._state.fingerprint); return this._state; }
      if (NO.test(low)) { this.notThat(); return this._state; }
    }
    if (NO.test(low) && ph !== 'idle') { this.notThat(); return this._state; }

    // The card asked for a missing slot: this is the answer.
    if (ph === 'ask' && this.pending && this._state.ask) {
      const slot = this._state.ask.slot;
      const reg = this.pending.reg;
      const def = this.toActDef(reg).slots[slot]!;
      const spec = reg.slots[slot]!;
      let cands: Candidate[];
      if (spec.type === 'freeText') cands = [{ value: said, label: said, score: 1 }];
      else if (def.resolve) cands = def.resolve(said, this.ctx(), {});
      else cands = matchOptions(said, optionsOf(spec));
      const top = cands[0];
      if (top && top.score >= 0.6) {
        this.pending.values[slot] = top.value;
        this.pending.labels[slot] = top.label ?? display(top.value);
        return this.advance();
      }
      // Not an answer to the question: treat it as a new request.
    }

    this.clearHold();
    this.pending = null;

    if (isKnowledgeQuestion(said)) {
      const a = answerFrom(this.skill.knowledge, said);
      this.stats.knowledge++;
      this.set({ phase: 'answer', said, channel, message: a ? a.entry.answer : NO_KNOWLEDGE, can: a ? a.entry.can : null });
      return this._state;
    }

    const defs = [...this.acts.values()].map((r) => this.toActDef(r));
    const ctx = this.ctx();
    const scores = this.local.scoreSync(said, defs, ctx, this.optionsFor);
    let decision = pickAct(scores);
    if (decision.kind === 'none') {
      // The act was named but a required slot was not given ("change the theme").
      // tacit's router scores that below the start threshold; Entoli opens the
      // act anyway so the card can ASK, which is still not consent to anything.
      const named = scores.filter((s) => s.score > 0 && s.phraseMatch >= 0.9);
      if (named.length === 1) decision = { kind: 'start', act: named[0]!.act, scores };
    }

    // Layer 2: the AI answers every new request, then the change goes on the card.
    const deviceOnly = decision.kind === 'start' && this.acts.get(decision.act)?.layer === 'L1';
    const anyAi = [...this.acts.values()].some((r) => r.layer === 'L2' && r.declared);
    if (anyAi && this.remote && !this.byo && !deviceOnly) {
      const hint = decision.kind === 'start' ? decision.act : null;
      this.set({ phase: 'thinking', said, channel });
      let choice: RemoteChoice = null;
      try {
        choice = await this.remote(this.remoteRequest(said, channel, hint, 'L2'));
      } catch (e) {
        // The AI is unreachable or over its limit: the device still understands what it can.
        if (decision.kind === 'none') {
          this.set({ phase: 'error', said, channel, message: `Could not reach Entoli: ${(e as Error).message}` });
          return this._state;
        }
        choice = null;
      }
      if (choice) {
        const reply = typeof choice.say === 'string' && choice.say.trim() ? choice.say.trim().slice(0, 400) : undefined;
        const reg = choice.act ? this.acts.get(choice.act) : undefined;
        // The model may only choose among declared, wired, Layer 2 acts. Anything else is no act.
        if (reg && reg.declared && reg.layer === 'L2') {
          const admitted = this.admit(reg, choice.slots ?? {});
          // When the device understood the same act, the AI only confirmed it: not a model guess.
          const agrees = decision.kind === 'start' && decision.act === reg.name;
          const fill = agrees ? this.fillLocal(said, defs.find((d) => d.name === reg.name)!, ctx) : { values: {}, labels: {} };
          return this.begin(reg, { values: { ...fill.values, ...admitted.values }, labels: { ...fill.labels, ...admitted.labels } }, said, channel, agrees ? 'device' : 'model', reply);
        }
        // A reply that came with a refused pick would describe something that will not happen.
        if (reply && !choice.act) {
          this.stats.model++;
          this.set({ phase: 'answer', said, channel, message: reply, can: null, via: 'model', reply });
          return this._state;
        }
      }
    }

    if (decision.kind === 'start') {
      const def = defs.find((d) => d.name === decision.act)!;
      return this.begin(this.acts.get(decision.act)!, this.fillLocal(said, def, ctx), said, channel, 'device');
    }
    if (decision.kind === 'narrow') {
      this.narrowText = said;
      this.stats.device++;
      this.set({
        phase: 'narrow', said, channel, message: 'Which one?',
        choices: decision.acts.map((a) => ({ act: a, title: this.acts.get(a)!.title })),
      });
      return this._state;
    }

    // Layer 1 has no Entoli AI; a developer's own resolver ("bring your own AI") may still be asked.
    if (this.byo && this.remote) {
      this.set({ phase: 'thinking', said, channel });
      let choice: RemoteChoice = null;
      try {
        choice = await this.remote(this.remoteRequest(said, channel, null, 'all'));
      } catch (e) {
        this.set({ phase: 'error', said, channel, message: `Could not reach the resolver: ${(e as Error).message}` });
        return this._state;
      }
      const reg = choice?.act ? this.acts.get(choice.act) : undefined;
      if (choice && reg && reg.declared) {
        const { values, labels } = this.admit(reg, choice.slots ?? {});
        return this.begin(reg, { values, labels }, said, channel, 'model');
      }
    }

    this.stats.unresolved++;
    this.set({
      phase: 'none', said, channel,
      message: isQuestionish(said) ? NO_KNOWLEDGE : "I can't do that here. Try one of these:",
      choices: [...this.acts.values()].slice(0, 4).map((r) => ({ act: r.name, title: r.title })),
    });
    return this._state;
  }

  /** Pick one act from a NARROW (or a suggestion). Picking is not consent: the card still asks. */
  async choose(act: string): Promise<StageState> {
    const reg = this.acts.get(act);
    if (!reg) return this._state;
    const said = this._state.phase === 'narrow' ? this.narrowText : '';
    const channel = this._state.channel ?? 'text';
    const fill = said ? this.fillLocal(said, this.toActDef(reg), this.ctx()) : { values: {}, labels: {} };
    return this.begin(reg, fill, said || reg.title, channel, 'device');
  }

  private fillLocal(said: string, def: ActDef, ctx: Ctx): { values: Record<string, unknown>; labels: Record<string, string> } {
    const cands = this.local.fillSync(said, def, {}, ctx, this.optionsFor);
    const values: Record<string, unknown> = {};
    const labels: Record<string, string> = {};
    for (const [slot, list] of Object.entries(cands)) {
      const top = list[0];
      if (!top) continue;
      values[slot] = top.value;
      labels[slot] = top.label ?? display(top.value);
    }
    return { values, labels };
  }

  /** Check a model's slot values against the declared types. Unknown or off-list values are dropped. */
  private admit(reg: Registered, raw: Record<string, unknown>) {
    const values: Record<string, unknown> = {};
    const labels: Record<string, string> = {};
    for (const [name, v] of Object.entries(raw)) {
      const s = reg.slots[name];
      if (!s || v === null || v === undefined) continue;
      if (s.type === 'choice' || s.type === 'person') {
        const opts = optionsOf(s);
        const hit = opts.find((o) => o.value === v || o.label.toLowerCase() === String(v).toLowerCase());
        if (hit) { values[name] = hit.value; labels[name] = hit.label; }
        else if (s.type === 'person' && opts.length === 0 && typeof v === 'string') { values[name] = v; labels[name] = v; }
      } else if (s.type === 'quantity') {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) { values[name] = { n, label: String(n) }; labels[name] = String(n); }
      } else if (s.type === 'when') {
        const c = resolveWhen(String(v), this.ctx())[0];
        if (c) { values[name] = c.value; labels[name] = c.label ?? String(v); }
      } else if (typeof v === 'string' && v.trim()) {
        values[name] = v.trim(); labels[name] = v.trim();
      }
    }
    return { values, labels };
  }

  private remoteRequest(phrase: string, channel: Channel, hint: string | null, which: 'L2' | 'all'): RemoteRequest {
    return {
      phrase,
      channel,
      layer: this.layer,
      ...(hint ? { hint } : {}),
      acts: [...this.acts.values()].filter((r) => r.declared && (which === 'all' || r.layer === 'L2')).map((r) => ({
        name: r.name,
        title: r.title,
        phrases: r.phrases,
        slots: Object.fromEntries(Object.entries(r.slots).map(([k, s]) => {
          const o = s.type === 'choice' || s.type === 'person' ? optionsOf(s).map((x) => String(x.value)) : undefined;
          return [k, o ? { type: s.type, options: o } : { type: s.type }];
        })),
      })),
    };
  }

  private begin(reg: Registered, fill: { values: Record<string, unknown>; labels: Record<string, string> }, said: string, channel: Channel, via: 'device' | 'model', reply?: string): StageState {
    this.stats[via]++;
    this.pending = { reg, values: { ...fill.values }, labels: { ...fill.labels }, via, said, channel, ...(reply ? { reply } : {}) };
    return this.advance();
  }

  private args(p: Pending): Arg[] {
    return Object.entries(p.reg.slots)
      .filter(([n]) => n in p.values)
      .map(([n, s]) => ({ name: n, label: s.label ?? humanize(n), value: p.values[n], display: p.labels[n] ?? display(p.values[n]) }));
  }

  /** Ask for what is missing, or put the act under the contract. */
  private advance(): StageState {
    const p = this.pending!;
    const { reg, said, channel } = p;
    const base = { said, channel, act: reg.name, title: reg.title, args: this.args(p), via: p.via, ...(p.reply ? { reply: p.reply } : {}) };

    for (const [name, s] of Object.entries(reg.slots)) {
      if (s.required && !(name in p.values)) {
        const opts = s.type === 'choice' || s.type === 'person' ? optionsOf(s).map((o) => o.label) : undefined;
        this.set({ ...base, phase: 'ask', ask: { slot: name, prompt: s.prompt ?? `${s.label ?? humanize(name)}?`, ...(opts ? { options: opts } : {}) } });
        return this._state;
      }
    }

    if (reg.prepare) {
      let out: Record<string, unknown> | string;
      try { out = reg.prepare({ ...p.values }); } catch (e) { out = (e as Error).message; }
      if (typeof out === 'string') {
        this.pending = null;
        this.set({ ...base, phase: 'error', message: out });
        return this._state;
      }
      for (const [k, v] of Object.entries(out)) {
        if (p.values[k] !== v) { p.values[k] = v; p.labels[k] = display(v); }
      }
      base.args = this.args(p);
    }

    let plan: CommitPlan = planCommit(
      { radius: reg.radius, undo: !!reg.undoFn, voiceOnly: reg.voiceOnly, exact: reg.exact, kind: reg.kind, fromModel: p.via === 'model' },
      channel,
    );
    if (plan.assent === 'hold' && this.confirmMode === 'always') plan = { assent: 'yes', why: 'This app asks before every action.' };
    if (plan.assent === 'blocked') {
      this.pending = null;
      this.set({ ...base, phase: 'blocked', message: plan.why, why: plan.why });
    } else if (plan.assent === 'exact') {
      this.set({ ...base, phase: 'exact', why: plan.why, fingerprint: fingerprint(reg.name, p.values) });
    } else if (plan.assent === 'yes') {
      this.set({ ...base, phase: 'confirm', why: plan.why });
    } else {
      const now = this.timers.now();
      this.set({ ...base, phase: 'hold', why: plan.why, holdMs: plan.holdMs, holdEndsAt: now + plan.holdMs });
      this.holdTimer = this.timers.set(() => { this.holdTimer = null; void this.commit(); }, plan.holdMs);
    }
    return this._state;
  }

  private clearHold(): void {
    if (this.holdTimer !== null) { this.timers.clear(this.holdTimer); this.holdTimer = null; }
  }

  /**
   * The explicit yes. On an exact card the yes must carry the fingerprint of
   * what was shown, and it must still match what would run.
   */
  async confirm(shown?: string): Promise<StageState> {
    const ph = this._state.phase;
    if (!this.pending || !(ph === 'hold' || ph === 'confirm' || ph === 'exact')) return this._state;
    if (ph === 'exact') {
      const now = fingerprint(this.pending.reg.name, this.pending.values);
      if (!shown || shown !== this._state.fingerprint || shown !== now) {
        this.clearHold();
        this.pending = null;
        this.set({ ...this._state, phase: 'error', message: 'What was shown is not what would run. Nothing happened. Ask again.' });
        return this._state;
      }
    }
    this.clearHold();
    return this.commit();
  }

  /** The way out. Always available; nothing runs. */
  notThat(): void {
    this.clearHold();
    const was = this._state;
    this.pending = null;
    this.set({ phase: 'idle', said: was.said, message: was.act ? `Not done: ${was.title}.` : undefined });
  }

  private async commit(): Promise<StageState> {
    const p = this.pending;
    if (!p) return this._state;
    this.pending = null;
    const { reg } = p;
    this.set({ ...this._state, phase: 'running' });
    try {
      const result = await reg.handler({ ...p.values }, { channel: p.channel, act: reg.name });
      const args = this.args(p);
      const summary = reg.describe?.(p.values) ?? [reg.title, ...args.map((a) => a.display)].filter(Boolean).join(' · ');
      const receipt: Receipt = { id: uid(), act: reg.name, title: reg.title, summary, at: this.timers.now(), undoable: !!reg.undoFn };
      if (reg.undoFn) {
        const fn = reg.undoFn;
        const values = { ...p.values };
        this.undoers.set(receipt.id, () => fn(result, values));
      }
      this.set({ phase: 'done', said: p.said, act: reg.name, title: reg.title, args, message: `Done: ${summary}`, receipts: [receipt, ...this._state.receipts].slice(0, 20) });
    } catch (e) {
      this.set({ phase: 'error', said: p.said, act: reg.name, title: reg.title, message: `That failed: ${(e as Error).message}` });
    }
    return this._state;
  }

  async undo(receiptId: string): Promise<boolean> {
    const fn = this.undoers.get(receiptId);
    const r = this._state.receipts.find((x) => x.id === receiptId);
    if (!fn || !r || r.undone) return false;
    await fn();
    this.undoers.delete(receiptId);
    this.set({ ...this._state, phase: 'done', message: `Undone: ${r.summary}`, receipts: this._state.receipts.map((x) => (x.id === receiptId ? { ...x, undone: true } : x)) });
    return true;
  }

  /** Clear the card (not the receipts). */
  reset(): void {
    this.clearHold();
    this.pending = null;
    this.set({ phase: 'idle' });
  }
}

function isQuestionish(s: string): boolean {
  return s.trim().endsWith('?');
}

function matchOptions(text: string, options: Option[]): Candidate[] {
  const toks = tokenize(text);
  const out: Candidate[] = [];
  for (const o of options) {
    let best = 0;
    for (const n of [o.label, ...(o.aliases ?? [])]) best = Math.max(best, matchPhrase(toks, n)?.score ?? 0);
    if (best > 0) out.push({ value: o.value, label: o.label, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The network fallback: POST {endpoint}/api/intent with the app key. */
export function httpResolver(endpoint: string, key: string, f: typeof fetch = globalThis.fetch?.bind(globalThis)): RemoteResolver {
  return async (req) => {
    if (!f) throw new Error('no fetch available');
    const res = await f(`${endpoint.replace(/\/$/, '')}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const msg = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
      throw new Error(msg ?? `HTTP ${res.status}`);
    }
    const body = (await res.json()) as RemoteChoice;
    return body;
  };
}

export { HOLD_MS };
