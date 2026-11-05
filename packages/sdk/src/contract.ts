/**
 * The commit contract. What may run on silence and what needs a yes.
 *
 *   self + undo               runs after a 1.6 s visible hold, with "Not that"
 *   anything else             needs an explicit yes
 *   external, or exact        "Do exactly this": every argument shown, and the
 *                             yes is bound to a fingerprint of what was shown
 *   voiceOnly, typed          refused
 *
 * The rules follow tacit's core (radius.ts / define.ts): no undo, no silence;
 * a setting is never changed on silence; a model's guess is never silent.
 */

import type { Radius } from './skill.js';

export const HOLD_MS = 1600;

export type Channel = 'text' | 'voice';

export type ContractInput = {
  radius: Radius;
  undo: boolean;
  voiceOnly?: boolean;
  exact?: boolean;
  kind?: 'feature' | 'setting';
  /** The act or a slot came from a model, not from an on-device match. */
  fromModel?: boolean;
};

export type CommitPlan =
  | { assent: 'hold'; holdMs: number; why: string }
  | { assent: 'yes'; why: string }
  | { assent: 'exact'; why: string }
  | { assent: 'blocked'; why: string };

export function planCommit(a: ContractInput, channel: Channel): CommitPlan {
  if (a.voiceOnly && channel !== 'voice') return { assent: 'blocked', why: 'This one is voice only. Say it instead of typing it.' };
  if (a.radius === 'external') return { assent: 'exact', why: 'It reaches outside the app, so it needs a yes to exactly this.' };
  if (a.exact) return { assent: 'exact', why: 'Declared exact: every argument is shown and the yes covers only these.' };
  if (a.radius === 'other-person') return { assent: 'yes', why: 'It affects someone else, so it needs a yes.' };
  if (a.kind === 'setting') return { assent: 'yes', why: 'Settings never change without a yes.' };
  if (!a.undo) return { assent: 'yes', why: 'It cannot be undone, so it needs a yes.' };
  if (a.fromModel) return { assent: 'yes', why: 'AI read this one, so it waits for a yes.' };
  return { assent: 'hold', holdMs: HOLD_MS, why: 'Yours only, and it can be undone.' };
}

/** Canonical JSON: object keys sorted, so the same arguments give the same string. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * Fingerprint of an exact action: the act and every argument as shown.
 * Two independent 32-bit FNV-1a lanes; enough to bind a click to a card, not
 * a security primitive against an attacker who controls the page.
 */
export function fingerprint(act: string, args: Record<string, unknown>): string {
  const s = canonical({ act, args });
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
