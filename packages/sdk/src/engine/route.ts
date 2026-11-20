/**
 * Act routing. Spec v0.2 §3.
 *
 * Acts compete for each utterance. A near-tie is not a coin flip: it becomes a
 * NARROW beat over the acts themselves, which is the same repair affordance the
 * method already uses for slots.
 */

import { DEFAULT_ROUTING, type ActScore, type RouteDecision, type RoutingConfig } from './resolve-types.js';

export function pickAct(scores: ActScore[], routing: RoutingConfig = DEFAULT_ROUTING): RouteDecision {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < routing.tauAct) return { kind: 'none', scores: ranked };

  const tied = ranked.filter(
    (s) => s.score >= routing.tauAct && top.score - s.score < routing.deltaAct,
  );

  // Two acts matched fully: the one whose phrase says more wins ("show notes about" over "show").
  if (tied.length > 1) {
    const by = [...tied].sort((a, b) => (b.phraseTokens ?? 0) - (a.phraseTokens ?? 0));
    const [lead, next] = [by[0]!, by[1]!];
    if (lead.phraseMatch >= routing.phraseFloor && (lead.phraseTokens ?? 0) >= (next.phraseTokens ?? 0) + 2) return { kind: 'start', act: lead.act, scores: ranked };
    return { kind: 'narrow', acts: tied.map((s) => s.act), scores: ranked };
  }
  return { kind: 'start', act: top.act, scores: ranked };
}
