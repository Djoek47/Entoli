/**
 * @entoli/analyzer: read a repository, draft entoli.skill.json.
 * Static pass always; the Claude pass when a key is available (and allowed).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Skill } from '@entoli/sdk/skill';
import { AiError, costMicros, hasAnthropicKey, type Usage } from './ai.js';
import { draftSkill, type Guess } from './draft.js';
import { refineWithClaude } from './refine.js';
import { scanRepo, type ScanOptions, type ScanResult } from './scan.js';

export type AnalyzeOptions = ScanOptions & {
  /** false: static heuristics only. Default: use Claude when ANTHROPIC_API_KEY is set. */
  ai?: boolean;
  model?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  client?: Anthropic;
  log?: (line: string) => void;
};

export type AnalyzeResult = {
  skill: Skill;
  scan: ScanResult;
  guesses: Guess[];
  usedModel: boolean;
  model?: string;
  usage: Usage;
  costMicros: number;
  log: string[];
};

export async function analyze(path: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const log: string[] = [];
  const say = (l: string) => { log.push(l); opts.log?.(l); };
  const scan = scanRepo(path, opts);
  say(`Read ${scan.files} files (${scan.frameworks.join(', ') || 'no framework detected'})${scan.skipped ? `, skipped ${scan.skipped}` : ''}${scan.truncated ? ', file limit reached' : ''}.`);
  say(`Found ${scan.screens.length} screens and ${scan.controls.length} controls (${scan.controls.filter((c) => c.setting).length} settings).`);
  const draft = draftSkill(scan);
  for (const n of draft.notes) say(n);
  say(`Static draft: ${draft.skill.acts.length} acts, ${draft.skill.map.length} map nodes.`);

  const zero: Usage = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  const wantAi = opts.ai ?? (hasAnthropicKey() || !!opts.client);
  if (!wantAi) {
    say('Model pass skipped (no ANTHROPIC_API_KEY, or --no-ai). Radius and undo are heuristic guesses: review them.');
    return { skill: draft.skill, scan, guesses: draft.guesses, usedModel: false, usage: zero, costMicros: 0, log };
  }
  try {
    say('Asking Claude to review the draft (it can only refine acts the scan found)…');
    const r = await refineWithClaude(scan, draft, {
      ...(opts.maxInputTokens ? { maxInputTokens: opts.maxInputTokens } : {}),
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.client ? { client: opts.client } : {}),
    });
    if (r.omitted) say(`Scan summary capped by the token budget: ${r.omitted} lower-priority controls were not sent to the model (they stay in the map).`);
    if (r.dropped.length) say(`Dropped from the model's reply (not backed by the scan): ${r.dropped.join(', ')}.`);
    for (const n of r.notes) say(`Model note: ${n}`);
    say(`Model pass: ${r.skill.acts.length} acts, ${r.skill.knowledge.length} knowledge entries · ${r.model} · ${r.usage.tokensIn} in / ${r.usage.tokensOut} out tokens · $${(r.costMicros / 1e6).toFixed(4)}.`);
    return { skill: r.skill, scan, guesses: draft.guesses, usedModel: true, model: r.model, usage: r.usage, costMicros: r.costMicros, log };
  } catch (e) {
    const usage = e instanceof AiError && e.usage ? e.usage : zero;
    const cost = e instanceof AiError && e.usage ? costMicros(e.model ?? '', e.usage) : 0;
    say(`Model pass failed (${(e as Error).message}); keeping the static draft.`);
    return { skill: draft.skill, scan, guesses: draft.guesses, usedModel: false, usage, costMicros: cost, log };
  }
}

export { scanRepo, draftSkill, refineWithClaude };
export { askJson, costMicros, hasAnthropicKey, AiError, DEFAULT_MODEL, type Usage, type AskJsonOptions, type AskJsonResult } from './ai.js';
export { mergeRefinement, summarize, REFINE_SCHEMA } from './refine.js';
export type { ScanResult, Control, Screen, Field } from './scan.js';
export type { Draft, Guess } from './draft.js';
