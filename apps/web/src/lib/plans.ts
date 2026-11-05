/** Pricing. Kept in one place: the dashboard, the limits and Stripe all read it. */
import type { PlanId } from '@/db/schema';

export type Plan = {
  id: PlanId;
  name: string;
  priceUsd: number;
  includedText: number;
  /** Per voice turn, USD. null: voice not included. */
  voicePerTurn: number | null;
  layers: ('L1' | 'L2')[];
  /** Hard stop when the included text intents run out (no overage billing). */
  hardLimit: boolean;
  maxApps?: number;
};

export const PLANS: Record<PlanId, Plan> = {
  developer: { id: 'developer', name: 'Developer', priceUsd: 0, includedText: 1_000, voicePerTurn: null, layers: ['L1'], hardLimit: true, maxApps: 1 },
  l1: { id: 'l1', name: 'L1 Control', priceUsd: 49, includedText: 25_000, voicePerTurn: 0.02, layers: ['L1'], hardLimit: false },
  l2: { id: 'l2', name: 'L2 Integrated', priceUsd: 299, includedText: 100_000, voicePerTurn: 0.015, layers: ['L1', 'L2'], hardLimit: false },
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
  const over = plan.hardLimit ? 0 : Math.ceil(overageUnits(plan, textIntents) / 1000) * OVERAGE_PER_1000;
  const voice = plan.voicePerTurn ? voiceTurns * plan.voicePerTurn : 0;
  return Math.round((plan.priceUsd + over + voice) * 100) / 100;
}
