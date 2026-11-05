/**
 * Static draft: scan result → entoli.skill.json, with no model.
 *
 * Every act comes from a control found in the code (a button's handler, a
 * form's submit, a settings input), so nothing here is invented. Radius and
 * undo are GUESSES from words in the code; they are marked as such in the
 * report and the developer confirms them in the dashboard.
 */
import { validateSkill, type KnowledgeEntry, type MapKind, type MapNode, type Radius, type Skill, type SkillAct, type SkillSlot } from '@entoli/sdk/skill';
import { humanize, type Control, type ScanResult } from './scan.js';

export type Guess = { act: string; radius: Radius; undo: boolean; why: string };
export type ActSource = { file: string; line: number; component?: string; handler?: string };
export type Draft = { skill: Skill; guesses: Guess[]; notes: string[]; sources: Record<string, ActSource[]> };

const EXTERNAL = /\b(pay|payment|purchase|checkout|buy|order|publish|deploy|billing|subscribe|subscription|transfer|withdraw|webhook|api key|password|email|phone|sign ?out|log ?out|delete account|close account)\b/;
const OTHER = /\b(send|share|invite|assign|message|mention|notify|post|comment|reply|forward|email to)\b/;
const NO_UNDO = /\b(delete|remove|destroy|erase|clear|reset|purge|send|pay|publish|deploy|sign ?out|log ?out|submit order|archive all)\b/;
const GENERIC = new Set(['ok', 'okay', 'save', 'submit', 'cancel', 'close', 'next', 'back', 'continue', 'done', 'apply', 'confirm', 'yes', 'no', 'go', 'x', '×', 'edit', 'more', 'menu', 'open']);
const SKIP_HANDLERS = /^(set(Open|Show|Visible|Expanded|Active|Hover|Focus|Menu|Modal|Dialog|Tab|Index|Page|Selected|Current|Editing|Draft)|toggle(Menu|Open|Sidebar|Drawer|Modal)|select|preventDefault|stopPropagation|onClose|close|open)$/;
/** A handler that only stores a value says nothing about WHICH value: name the act after the field instead. */
const SETTER = /^(set|update|change)[A-Z]|^(setState|dispatch|onChange|handleChange)$/;
const SEARCH = /\b(search|filter|find|query)\b/i;
const CREATES = /\b(add|create|new|save|submit|send|post|update|apply|book|invite|share)\b/i;

function actName(c: Control): string {
  const fieldName = c.fields?.[0]?.name ?? c.name;
  const useLabel = !c.handler || /^(navigate|push|replace)$/.test(c.handler) || (SETTER.test(c.handler) && (c.kind !== 'button' && c.kind !== 'form'));
  const base = useLabel ? (fieldName && fieldName !== 'text' ? fieldName : c.label) : c.handler!.replace(/^(handle|on)(?=[A-Z])/, '');
  const parts = base.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((p) => p.toLowerCase());
  if (!parts.length) return '';
  const name = parts[0]! + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[a-z]/.test(name) ? name : `act${name}`;
}

function phrasesFor(c: Control, screenTitle: string): string[] {
  const out = new Set<string>();
  const label = c.label.toLowerCase().replace(/[^\p{L}\p{N} '-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (label && label.length > 1 && !GENERIC.has(label) && label.split(' ').length <= 6) out.add(label);
  if (c.handler && !/^(navigate|push|replace)$/.test(c.handler) && !SETTER.test(c.handler)) out.add(humanize(c.handler).toLowerCase());
  if (label && GENERIC.has(label)) out.add(`${label} ${screenTitle.toLowerCase()}`);
  if (c.kind === 'select' || c.kind === 'input' || c.kind === 'toggle') {
    const what = humanize(c.name ?? c.label).toLowerCase();
    out.add(`change ${what}`);
    out.add(`set ${what}`);
  }
  return [...out].filter((p) => p.length > 1).slice(0, 5);
}

function slotsFor(c: Control): Record<string, SkillSlot> {
  const slots: Record<string, SkillSlot> = {};
  for (const f of c.fields ?? []) {
    const s: SkillSlot = { type: f.type, label: f.label };
    if ((f.type === 'choice' || f.type === 'person') && f.options?.length) s.options = f.options;
    if (f.required || c.kind !== 'form') s.required = true;
    slots[f.name] = s;
  }
  if (c.kind === 'toggle' && !Object.keys(slots).length) slots.on = { type: 'choice', options: ['on', 'off'], required: true };
  return slots;
}

function guess(c: Control): { radius: Radius; undo: boolean; why: string } {
  const words = humanize(`${c.handler ?? ''} ${c.label} ${c.name ?? ''} ${(c.fields ?? []).map((f) => f.name).join(' ')}`).toLowerCase();
  if (EXTERNAL.test(words)) return { radius: 'external', undo: false, why: `"${EXTERNAL.exec(words)![0]}" reaches outside the app or the account` };
  if (OTHER.test(words)) return { radius: 'other-person', undo: !NO_UNDO.test(words), why: `"${OTHER.exec(words)![0]}" reaches another person` };
  if (NO_UNDO.test(words)) return { radius: 'self', undo: false, why: `"${NO_UNDO.exec(words)![0]}" is usually not reversible` };
  return { radius: 'self', undo: true, why: 'changes only this user\'s own view or data' };
}

function selectorFor(c: Control): string | undefined {
  if (c.testId) return `[data-testid="${c.testId}"]`;
  if (c.elementId) return `#${c.elementId}`;
  if (c.name && (c.kind === 'input' || c.kind === 'select')) return `[name="${c.name}"]`;
  if (c.kind === 'link' && c.href) return `a[href="${c.href}"]`;
  if (c.label && c.kind === 'button') return `role=button[name="${c.label.replace(/"/g, '\\"')}"]`;
  return undefined;
}

const KIND: Record<Control['kind'], MapKind> = { button: 'button', link: 'link', form: 'form', input: 'form', select: 'form', toggle: 'form' };

export function draftSkill(scan: ScanResult): Draft {
  const notes: string[] = [];
  const guesses: Guess[] = [];
  const map: MapNode[] = [];
  const acts = new Map<string, SkillAct>();
  const screenTitle = new Map(scan.screens.map((s) => [s.id, s.title]));

  for (const s of scan.screens) map.push({ id: s.id, kind: 'screen', title: s.title, path: s.path });
  const hasShared = scan.controls.some((c) => c.screen === 'shared');
  if (hasShared) map.push({ id: 'shared', kind: 'menu', title: 'Everywhere (shared UI)' });

  const usedIds = new Set(map.map((m) => m.id));
  const sources: Record<string, ActSource[]> = {};
  const addSource = (name: string, c: Control) => {
    const src: ActSource = { file: c.file, line: c.line, ...(c.component ? { component: c.component } : {}), ...(c.handler ? { handler: c.handler } : {}) };
    (sources[name] ??= []).push(src);
  };
  let settingsFound = 0;

  // Plain text/number/date inputs are not acts on their own: typing is not
  // asking. They become slots of the create/submit button next to them.
  const looseInputs = new Map<string, Control[]>();
  const keyOf = (c: Control) => `${c.file}#${c.component ?? ''}`;
  for (const c of scan.controls) {
    if (c.kind === 'input' && !c.setting && !SEARCH.test(`${c.label} ${c.name ?? ''} ${c.inputType ?? ''}`)) {
      (looseInputs.get(keyOf(c)) ?? looseInputs.set(keyOf(c), []).get(keyOf(c))!).push(c);
    }
  }
  const screenTitles = new Set(scan.screens.map((s) => s.title.toLowerCase()));

  for (const c of scan.controls) {
    const parent = c.screen && usedIds.has(c.screen) ? c.screen : hasShared ? 'shared' : scan.screens[0]?.id;
    const node: MapNode = { id: `${parent ?? 'node'}.${c.id}`, kind: c.setting ? 'setting' : KIND[c.kind], title: c.label || humanize(c.handler ?? c.kind) };
    if (parent) node.parent = parent;
    const sel = selectorFor(c);
    if (sel) node.selector = sel;
    if (c.kind === 'link' && c.href) node.path = c.href;

    const isLoose = c.kind === 'input' && (looseInputs.get(keyOf(c)) ?? []).includes(c);
    // A button that only switches screens is navigation (nav.open covers it).
    const isNavButton = c.kind === 'button' && !!c.handler && SETTER.test(c.handler) && (screenTitles.has(c.label.toLowerCase()) || /screen|tab|page|view|route/i.test(c.handler));
    const actionable = c.kind !== 'link' && !!c.handler && !SKIP_HANDLERS.test(c.handler) && !isLoose && !isNavButton;
    if (actionable) {
      const name = actName(c);
      if (name) {
        let act = acts.get(name);
        if (!act) {
          const g = guess(c);
          const slots = slotsFor(c);
          if (c.kind === 'button' && CREATES.test(`${c.label} ${c.handler ?? ''}`)) {
            for (const input of looseInputs.get(keyOf(c)) ?? []) {
              for (const f of input.fields ?? []) {
                if (!(f.name in slots)) slots[f.name] = { type: f.type, label: f.label, ...(f.type === 'freeText' && !Object.values(slots).some((x) => x.required) ? { required: true } : {}) };
              }
            }
          }
          const title = c.handler && !SETTER.test(c.handler) ? humanize(c.handler) : humanize(name);
          act = { name, title, phrases: phrasesFor(c, screenTitle.get(parent ?? '') ?? ''), radius: g.radius, slots };
          if (g.undo) act.undo = true;
          if (c.setting) {
            act.kind = 'setting';
            act.voiceOnly = true; // Layer 2: settings change by voice only, with a yes.
            settingsFound++;
          }
          if (g.radius === 'external') act.exact = true;
          if (parent && parent !== 'shared') act.screen = parent;
          if (act.phrases.length === 0) act.phrases = [humanize(name).toLowerCase()];
          acts.set(name, act);
          guesses.push({ act: name, radius: g.radius, undo: g.undo, why: g.why });
        }
        node.act = name;
        addSource(name, c);
      }
    }
    map.push(node);
  }

  // Navigation: one act that opens any screen with a concrete path.
  const navigable = scan.screens.filter((s) => !s.path.includes(':'));
  if (navigable.length > 1) {
    acts.set('nav.open', {
      name: 'nav.open', title: 'Go to', phrases: ['go to', 'open', 'show me', 'take me to'], radius: 'self', undo: true,
      slots: { screen: { type: 'choice', required: true, label: 'Screen', options: navigable.map((s) => ({ value: s.path, label: s.title })) } },
    });
    guesses.push({ act: 'nav.open', radius: 'self', undo: true, why: 'navigation only' });
  }

  const actList = [...acts.values()];
  // Layer 1 (no AI) by default; the developer chooses Layer 2 when they want the AI to answer.
  const layer = 'L1' as const;
  if (settingsFound) notes.push(`${settingsFound} setting act(s) found: settings are voice only and always need a yes.`);
  if (scan.truncated) notes.push('The repository has more files than the scan limit; some controls were not read.');

  const knowledge: KnowledgeEntry[] = actList.map((a) => ({ topic: (a.title ?? a.name).toLowerCase(), can: true, answer: `Yes. Say "${a.phrases[0]}".` }));

  const skill: Skill = { entoli: '0.1', app: { name: scan.appName }, layer, mode: 'text', map, knowledge, acts: actList };
  const v = validateSkill(skill);
  if (!v.ok) notes.push(...v.errors.map((e) => `draft problem: ${e}`));
  return { skill, guesses, notes, sources };
}
