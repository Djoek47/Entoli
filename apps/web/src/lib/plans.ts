/** Pricing. Kept in one place: the dashboard, the limits and Stripe all read it. */
import type { PlanId } from '@/db/schema';

/**
 * What each plan sells.
 *   Developer / L1  the SKILL: analyzer, map, SDK, keys, tester, export to coding
 *                   agents. Layer 1 only: the device answers, no Entoli AI;
 *                   voice input is transcription; bring your own AI if you want one.
 *   L2              the skill AND the integration: Entoli's AI answers your users
 *                   (Layer 2, metered), and the voice tool lets you integrate your
 *                   app by speaking to the dashboard, within a monthly quota.
 */
export type Plan = {
  id: PlanId;
  name: string;
  priceUsd: number;
  /** Entoli AI at runtime (Layer 2). */
  ai: boolean;
  /** AI intents included a month (Layer 2 only). */
  includedText: number;
  /** Per AI voice turn, USD (Layer 2 only). */
  voicePerTurn: number | null;
  layers: ('L1' | 'L2')[];
  /** Voice-tool turns a month in the dashboard (integrate by speaking). 0: not included. */
  voiceToolTurns: number;
  /** AI-written integration pull request. */
  integration: boolean;
  /** Hard stop when the included intents run out (no overage billing). */
  hardLimit: boolean;
  /** Voice input on the end user's device (transcription only on Layer 1). */
  voiceInput: boolean;
  maxApps?: number;
};

export const PLANS: Record<PlanId, Plan> = {
  developer: { id: 'developer', name: 'Developer', priceUsd: 0, ai: false, includedText: 0, voicePerTurn: null, layers: ['L1'], voiceToolTurns: 0, integration: false, hardLimit: true, voiceInput: false, maxApps: 1 },
  l1: { id: 'l1', name: 'L1 Skill', priceUsd: 49, ai: false, includedText: 0, voicePerTurn: null, layers: ['L1'], voiceToolTurns: 0, integration: false, hardLimit: true, voiceInput: true },
  l2: { id: 'l2', name: 'L2 Skill + integration', priceUsd: 299, ai: true, includedText: 100_000, voicePerTurn: 0.015, layers: ['L1', 'L2'], voiceToolTurns: Number(process.env.VOICE_TOOL_TURNS ?? 300), integration: true, hardLimit: false, voiceInput: true },
};

/** Extra text intents beyond the plan, USD per 1,000. */
export const OVERAGE_PER_1000 = 2;
export const MANAGED_SETUP_FROM_USD = 2_500;

/** Soft limit: warn the developer at this share of the included intents. */
export const SOFT_LIMIT_SHARE = 0.8;

export function period(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function overageUnits(plan: Plan, textIntents: number): number {
  return Math.max(0, textIntents - plan.includedText);
}

/** Estimated bill for the month, in USD. */
export function estimate(plan: Plan, textIntents: number, voiceTurns: number): number {
  if (!plan.ai) return plan.priceUsd;
  const over = plan.hardLimit ? 0 : Math.ceil(overageUnits(plan, textIntents) / 1000) * OVERAGE_PER_1000;
  const voice = plan.voicePerTurn ? voiceTurns * plan.voicePerTurn : 0;
  return Math.round((plan.priceUsd + over + voice) * 100) / 100;
}

/** The plan as a list, for the pricing page, the billing tab and the site. */
export function planFeatures(p: Plan): string[] {
  if (p.id === 'developer') return ['1 app, Layer 1', 'Analyzer, map, knowledge, tester', 'Typed requests, answered on the device'];
  if (!p.ai) return ['The skill for your app', 'Layer 1: the device answers, no AI at runtime', 'Voice input (transcription) included', 'Export the skill to Claude Code, Cursor and other coding agents', 'Bring your own AI if you want one'];
  return [
    'Everything in L1, plus integration',
    `Layer 2: Entoli AI answers your users, ${p.includedText.toLocaleString()} intents a month, then $${OVERAGE_PER_1000} per 1,000`,
    `AI voice turns $${p.voicePerTurn} each`,
    `Voice tool: integrate your app by speaking to the dashboard (${p.voiceToolTurns} turns a month)`,
    'Integration delivered as one pull request you approve',
    'Choose Layer 1, Layer 2 or off for each feature',
  ];
}
