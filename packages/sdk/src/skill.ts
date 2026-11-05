/**
 * entoli.skill.json: the format and its validator.
 *
 * The skill is the contract between an app and Entoli. It names every act the
 * app exposes, what each one may touch (radius), whether it can be undone,
 * and what the app can and cannot do (knowledge). At runtime the AI may only
 * choose among the acts declared here; it can never invent one.
 *
 * The slot types are a CLOSED set. A slot type nobody wrote a matcher and a
 * renderer for is a slot that cannot be shown or checked, so it is refused.
 */

export const SKILL_VERSION = '0.1' as const;

export const SLOT_TYPES = ['choice', 'quantity', 'when', 'person', 'freeText'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const RADII = ['self', 'other-person', 'external'] as const;
export type Radius = (typeof RADII)[number];

export const LAYERS = ['L1', 'L2'] as const;
export type Layer = (typeof LAYERS)[number];

export const MODES = ['text', 'voice'] as const;
export type Mode = (typeof MODES)[number];

export const MAP_KINDS = ['screen', 'menu', 'button', 'form', 'setting', 'link'] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export type ChoiceOption = string | { value: string; label?: string; aliases?: string[] };

export type SkillSlot = {
  type: SlotType;
  /** For choice and person: the values the slot may take. */
  options?: ChoiceOption[];
  required?: boolean;
  /** What the Stage asks when the slot is missing. */
  prompt?: string;
  /** Shown on the card in place of the slot name. */
  label?: string;
};

export type SkillAct = {
  name: string;
  title?: string;
  description?: string;
  /** Trigger phrases matched on device. */
  phrases: string[];
  slots?: Record<string, SkillSlot>;
  radius: Radius;
  /** true when the app can take it back. Without undo nothing commits on silence. */
  undo?: boolean;
  /** Only by voice. Typed requests are refused. */
  voiceOnly?: boolean;
  /** Show every argument and bind the yes to exactly what was shown. */
  exact?: boolean;
  /** 'setting' acts change how the app behaves (Layer 2) and always need a yes. */
  kind?: 'feature' | 'setting';
  /** The map node this act lives on. */
  screen?: string;
};

export type MapNode = {
  id: string;
  kind: MapKind;
  title: string;
  /** Route or URL path, for screens. */
  path?: string;
  parent?: string;
  /** CSS selector that finds it in the running app (used by the tester). */
  selector?: string;
  /** The act this node performs, if any. */
  act?: string;
};

export type KnowledgeEntry = {
  /** What the entry is about, in the user's words: "export to PDF". */
  topic: string;
  /** Whether the app can do it. */
  can: boolean;
  /** The answer, as said to the user. */
  answer: string;
  /** Other ways people ask. */
  phrases?: string[];
};

export type Skill = {
  $schema?: string;
  entoli: typeof SKILL_VERSION;
  app: { name: string; id?: string; url?: string; repo?: string };
  layer: Layer;
  mode: Mode;
  map: MapNode[];
  knowledge: KnowledgeEntry[];
  acts: SkillAct[];
};

export type ValidationResult = { ok: true; skill: Skill; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

const NAME = /^[a-z][a-zA-Z0-9_.-]*$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Validates an untrusted value (parsed JSON) as an Entoli skill. */
export function validateSkill(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (path: string, m: string) => errors.push(`${path}: ${m}`);

  if (!isObj(input)) return { ok: false, errors: ['skill: must be an object'], warnings };
  const s = input;

  if (s.entoli !== SKILL_VERSION) err('entoli', `must be "${SKILL_VERSION}"`);
  if (!isObj(s.app) || typeof s.app.name !== 'string' || !s.app.name) err('app.name', 'required string');
  if (!oneOf(LAYERS, s.layer)) err('layer', `must be one of ${LAYERS.join(', ')}`);
  if (!oneOf(MODES, s.mode)) err('mode', `must be one of ${MODES.join(', ')}`);

  // map
  const nodeIds = new Set<string>();
  if (!Array.isArray(s.map)) err('map', 'must be an array');
  else {
    s.map.forEach((n, i) => {
      const p = `map[${i}]`;
      if (!isObj(n)) return err(p, 'must be an object');
      if (typeof n.id !== 'string' || !n.id) err(`${p}.id`, 'required string');
      else if (nodeIds.has(n.id)) err(`${p}.id`, `duplicate id "${n.id}"`);
      else nodeIds.add(n.id);
      if (!oneOf(MAP_KINDS, n.kind)) err(`${p}.kind`, `must be one of ${MAP_KINDS.join(', ')}`);
      if (typeof n.title !== 'string' || !n.title) err(`${p}.title`, 'required string');
    });
    s.map.forEach((n, i) => {
      if (isObj(n) && typeof n.parent === 'string' && !nodeIds.has(n.parent)) err(`map[${i}].parent`, `unknown node "${n.parent}"`);
    });
  }

  // knowledge
  if (!Array.isArray(s.knowledge)) err('knowledge', 'must be an array');
  else {
    s.knowledge.forEach((k, i) => {
      const p = `knowledge[${i}]`;
      if (!isObj(k)) return err(p, 'must be an object');
      if (typeof k.topic !== 'string' || !k.topic) err(`${p}.topic`, 'required string');
      if (typeof k.can !== 'boolean') err(`${p}.can`, 'required boolean');
      if (typeof k.answer !== 'string' || !k.answer) err(`${p}.answer`, 'required string');
      if (k.phrases !== undefined && !(Array.isArray(k.phrases) && k.phrases.every((x) => typeof x === 'string'))) err(`${p}.phrases`, 'must be an array of strings');
    });
  }

  // acts
  const actNames = new Set<string>();
  if (!Array.isArray(s.acts)) err('acts', 'must be an array');
  else {
    s.acts.forEach((a, i) => {
      const p = `acts[${i}]`;
      if (!isObj(a)) return err(p, 'must be an object');
      if (typeof a.name !== 'string' || !NAME.test(a.name)) err(`${p}.name`, 'required, letters/digits/._- starting with a lowercase letter');
      else if (actNames.has(a.name)) err(`${p}.name`, `duplicate act "${a.name}"`);
      else actNames.add(a.name);
      if (!Array.isArray(a.phrases) || a.phrases.length === 0 || !a.phrases.every((x) => typeof x === 'string' && x.trim()))
        err(`${p}.phrases`, 'at least one non-empty phrase');
      if (!oneOf(RADII, a.radius)) err(`${p}.radius`, `must be one of ${RADII.join(', ')}`);
      for (const f of ['undo', 'voiceOnly', 'exact'] as const) {
        if (a[f] !== undefined && typeof a[f] !== 'boolean') err(`${p}.${f}`, 'must be boolean');
      }
      if (a.kind !== undefined && a.kind !== 'feature' && a.kind !== 'setting') err(`${p}.kind`, 'must be "feature" or "setting"');
      if (a.kind === 'setting' && s.layer !== 'L2') err(`${p}.kind`, 'setting acts need layer "L2"');
      if (typeof a.screen === 'string' && Array.isArray(s.map) && !nodeIds.has(a.screen)) err(`${p}.screen`, `unknown map node "${a.screen}"`);
      if (a.radius === 'self' && a.undo !== true) warnings.push(`${p}: radius "self" without undo always needs a yes`);
      if (a.slots !== undefined) {
        if (!isObj(a.slots)) err(`${p}.slots`, 'must be an object');
        else {
          for (const [sn, slot] of Object.entries(a.slots)) {
            const sp = `${p}.slots.${sn}`;
            if (!isObj(slot)) { err(sp, 'must be an object'); continue; }
            if (!oneOf(SLOT_TYPES, slot.type)) { err(`${sp}.type`, `must be one of ${SLOT_TYPES.join(', ')} (closed set)`); continue; }
            if (slot.options !== undefined) {
              const okOpts = Array.isArray(slot.options) && slot.options.every((o) => typeof o === 'string' || (isObj(o) && typeof o.value === 'string'));
              if (!okOpts) err(`${sp}.options`, 'must be strings or { value, label?, aliases? }');
              if (slot.type !== 'choice' && slot.type !== 'person') err(`${sp}.options`, `only choice and person slots take options`);
            }
            if (slot.type === 'choice' && (!Array.isArray(slot.options) || slot.options.length === 0))
              warnings.push(`${sp}: choice slot has no options in the skill; the app must supply them at runtime`);
            if (slot.required !== undefined && typeof slot.required !== 'boolean') err(`${sp}.required`, 'must be boolean');
          }
        }
      }
    });
    if (Array.isArray(s.map)) {
      s.map.forEach((n, i) => {
        if (isObj(n) && typeof n.act === 'string' && !actNames.has(n.act)) err(`map[${i}].act`, `unknown act "${n.act}"`);
      });
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, skill: input as unknown as Skill, warnings };
}

/** Throws with every problem listed. For app start-up, where a bad skill should fail loudly. */
export function assertSkill(input: unknown): Skill {
  const r = validateSkill(input);
  if (!r.ok) throw new Error(`Invalid entoli.skill.json:\n  ${r.errors.join('\n  ')}`);
  return r.skill;
}

export function optionValue(o: ChoiceOption): { value: string; label: string; aliases: string[] } {
  if (typeof o === 'string') return { value: o, label: o, aliases: [] };
  return { value: o.value, label: o.label ?? o.value, aliases: o.aliases ?? [] };
}

/** A JSON Schema (draft 2020-12) for editors. The validator above is the authority. */
export const skillJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://entoli.dev/schema/skill-0.1.json',
  title: 'entoli.skill.json',
  type: 'object',
  required: ['entoli', 'app', 'layer', 'mode', 'map', 'knowledge', 'acts'],
  properties: {
    entoli: { const: SKILL_VERSION },
    app: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' } } },
    layer: { enum: [...LAYERS] },
    mode: { enum: [...MODES] },
    map: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'title'],
        properties: {
          id: { type: 'string' }, kind: { enum: [...MAP_KINDS] }, title: { type: 'string' },
          path: { type: 'string' }, parent: { type: 'string' }, selector: { type: 'string' }, act: { type: 'string' },
        },
      },
    },
    knowledge: {
      type: 'array',
      items: {
        type: 'object', required: ['topic', 'can', 'answer'],
        properties: { topic: { type: 'string' }, can: { type: 'boolean' }, answer: { type: 'string' }, phrases: { type: 'array', items: { type: 'string' } } },
      },
    },
    acts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'phrases', 'radius'],
        properties: {
          name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
          phrases: { type: 'array', minItems: 1, items: { type: 'string' } },
          radius: { enum: [...RADII] }, undo: { type: 'boolean' }, voiceOnly: { type: 'boolean' }, exact: { type: 'boolean' },
          kind: { enum: ['feature', 'setting'] }, screen: { type: 'string' },
          slots: {
            type: 'object',
            additionalProperties: {
              type: 'object', required: ['type'],
              properties: {
                type: { enum: [...SLOT_TYPES] }, required: { type: 'boolean' }, prompt: { type: 'string' }, label: { type: 'string' },
                options: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['value'] }] } },
              },
            },
          },
        },
      },
    },
  },
} as const;
