/**
 * useEntoli: wire an act to a React component's real function.
 *
 *   useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), {
 *     undo: (note) => removeNote((note as Note).id),
 *   });
 *
 * The handler is read through a ref, so it always sees the latest state
 * without re-registering on every render.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getEntoli, onEntoli } from './mount.js';
import type { ChoiceOption } from './skill.js';
import type { ActHandler, ActOptions, Entoli, SlotsSpec, StageState } from './runtime.js';

export function useEntoli(name: string, slots: SlotsSpec, handler: ActHandler, opts: ActOptions = {}): void {
  const h = useRef(handler);
  h.current = handler;
  const o = useRef(opts);
  o.current = opts;
  const entoli = useEntoliInstance();
  // Re-register when the shape changes; functions inside are read through refs.
  const shape = JSON.stringify({ slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, typeof v === 'string' ? v : { ...v, options: typeof v.options === 'function' ? 'fn' : v.options }])), radius: opts.radius, voiceOnly: opts.voiceOnly, exact: opts.exact, kind: opts.kind, title: opts.title, phrases: opts.phrases, undo: !!opts.undo });
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  useEffect(() => {
    if (!entoli) return;
    const live: SlotsSpec = {};
    for (const [k, v] of Object.entries(slotsRef.current)) {
      live[k] = typeof v === 'string' || typeof v.options !== 'function' ? v : { ...v, options: (): ChoiceOption[] => {
        const cur = slotsRef.current[k];
        if (typeof cur !== 'object' || !cur.options) return [];
        return typeof cur.options === 'function' ? cur.options() : cur.options;
      } };
    }
    const cur = o.current;
    const opt: ActOptions = { ...cur };
    if (cur.undo) opt.undo = (r, s) => o.current.undo?.(r, s);
    if (cur.describe) opt.describe = (s) => o.current.describe?.(s) ?? '';
    return entoli.register(name, live, (s, info) => h.current(s, info), opt);
  }, [entoli, name, shape]);
}

/** The mounted instance (re-renders when mount/unmount happens). */
export function useEntoliInstance(): Entoli | null {
  const [e, setE] = useState<Entoli | null>(() => getEntoli());
  useEffect(() => {
    setE(getEntoli());
    return onEntoli(setE);
  }, []);
  return e;
}

/** The Stage state, for apps that draw their own card. */
export function useStage(): StageState | null {
  const e = useEntoliInstance();
  return useSyncExternalStore(
    (cb) => (e ? e.subscribe(() => cb()) : () => {}),
    () => (e ? e.state : null),
    () => null,
  );
}
