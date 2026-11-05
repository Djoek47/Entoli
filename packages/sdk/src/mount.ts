/**
 * mount() and defineAct(): the two calls a vanilla JS app needs.
 *
 *   const entoli = mount({ el: '#entoli', skill, key, mode: 'text' });
 *   defineAct('note.create', { text: 'freeText' }, ({ text }) => notes.add(text), { undo: (n) => notes.remove(n.id) });
 */

import { Entoli, type ActHandler, type ActOptions, type EntoliOptions, type SlotsSpec } from './runtime.js';
import { assertSkill, type Mode } from './skill.js';
import { renderStage, type StageHandle, type StageOptions } from './stage.js';
import { webSpeech, type SpeechProvider } from './voice.js';

export type MountOptions = Omit<EntoliOptions, 'skill' | 'mode'> & StageOptions & {
  /** Where to draw the command bar and Stage. Left out, nothing is drawn (headless). */
  el?: string | HTMLElement | null;
  /** The parsed entoli.skill.json. Validated on mount; an invalid skill throws. */
  skill: unknown;
  mode?: Mode;
};

export type Mounted = Entoli & { stage: StageHandle | null; unmount(): void };

let current: Entoli | null = null;
type Queued = { name: string; slots: SlotsSpec; handler: ActHandler; opts: ActOptions; off?: () => void; cancelled?: boolean };
const queue: Queued[] = [];
const waiters = new Set<(e: Entoli | null) => void>();

/** The instance mount() made, for hooks and defineAct. */
export function getEntoli(): Entoli | null {
  return current;
}

export function onEntoli(fn: (e: Entoli | null) => void): () => void {
  waiters.add(fn);
  return () => waiters.delete(fn);
}

function setCurrent(e: Entoli | null): void {
  current = e;
  if (e) for (const q of queue) if (!q.cancelled) q.off = e.register(q.name, q.slots, q.handler, q.opts);
  for (const w of waiters) w(e);
}

export function mount(opts: MountOptions): Mounted {
  const skill = assertSkill(opts.skill);
  const { el, fonts, placeholder, speech, speak, document: doc, ...rest } = opts;
  const entoli = new Entoli({ ...rest, skill, ...(opts.mode ? { mode: opts.mode } : {}) }) as Mounted;

  let stage: StageHandle | null = null;
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  const target = typeof el === 'string' ? d?.querySelector<HTMLElement>(el) : el;
  if (el && !target) throw new Error(`[entoli] mount: no element matches ${String(el)}`);
  if (target) {
    const so: StageOptions = {};
    if (fonts !== undefined) so.fonts = fonts;
    if (placeholder !== undefined) so.placeholder = placeholder;
    if (speak !== undefined) so.speak = speak;
    if (d) so.document = d;
    const sp: SpeechProvider | undefined = speech ?? (entoli.mode === 'voice' ? webSpeech() : undefined);
    if (sp) so.speech = sp;
    stage = renderStage(entoli, target, so);
  }
  entoli.stage = stage;
  entoli.unmount = () => {
    stage?.destroy();
    entoli.reset();
    if (current === entoli) setCurrent(null);
  };
  setCurrent(entoli);
  return entoli;
}

/**
 * Wire an act for plain JS. Works before or after mount(): acts defined early
 * are registered when the instance appears. Returns a function that removes it.
 */
export function defineAct(name: string, slots: SlotsSpec, handler: ActHandler, opts: ActOptions = {}): () => void {
  const q: Queued = { name, slots, handler, opts };
  queue.push(q);
  if (current) q.off = current.register(name, slots, handler, opts);
  return () => {
    q.cancelled = true;
    q.off?.();
    const i = queue.indexOf(q);
    if (i >= 0) queue.splice(i, 1);
  };
}
