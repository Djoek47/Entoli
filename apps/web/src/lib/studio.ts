/**
 * The voice tool: the dashboard, operated by Entoli itself.
 *
 * On the L2 plan the developer integrates their app by speaking ("analyze my
 * repo", "expose new note and search, voice, admins only", "approve the theme
 * change", "open the pull request"). Entoli's AI answers and drives the
 * dashboard through the same contract as any Entoli app: navigation runs after
 * a short hold, preparing changes needs a yes, publishing and opening the pull
 * request show exactly what will happen. On other plans the bar runs as
 * Layer 1: the device answers, no AI.
 */
import { STUDIO_SKILL } from './studio-skill';
import type { DB } from '@/db';
import { getApp, getUsage, meter } from './apps';
import { claudeChooser, admit, type CandidateAct, type Chooser } from './intent';
import { hasAnthropicKey, type Usage } from '@entoli/analyzer';
import { PLANS } from './plans';
import { hit } from './ratelimit';

type ClientAct = { name: string; slots: Record<string, { type: string; options?: string[] }> };

export type StudioResult = { status: number; body: Record<string, unknown> };

/** POST /api/studio/intent: the AI behind the dashboard's own bar (L2 plan, voice-tool quota). */
export async function handleStudioIntent(db: DB, userId: string, body: { appId?: unknown; phrase?: unknown; channel?: unknown; acts?: unknown; hint?: unknown }, deps: { choose?: Chooser; modelAvailable?: boolean } = {}): Promise<StudioResult> {
  const app = typeof body.appId === 'string' ? await getApp(db, userId, body.appId) : null;
  if (!app) return { status: 404, body: { error: 'app not found' } };
  const plan = PLANS[app.plan];
  if (!plan.voiceToolTurns) return { status: 402, body: { error: 'The voice tool is part of the L2 plan.' } };
  const phrase = typeof body.phrase === 'string' ? body.phrase.trim() : '';
  if (!phrase || phrase.length > 500) return { status: 400, body: { error: 'phrase must be 1-500 characters' } };
  if (!(await hit(db, `studio:${app.id}`, 60)).ok) return { status: 429, body: { error: 'Slow down a little.' } };
  const usage = await getUsage(db, app.id);
  if (usage.toolTurns >= plan.voiceToolTurns) return { status: 402, body: { error: `This month's ${plan.voiceToolTurns} voice-tool turns are used. The bar still works on the device; the turns reset on the 1st.` } };
  if (!(deps.modelAvailable ?? hasAnthropicKey())) return { status: 200, body: { act: null, slots: {}, reason: 'model unavailable' } };

  // Candidates: studio acts the page has wired, with the page's runtime options (changes, features).
  const client = Array.isArray(body.acts) ? (body.acts as ClientAct[]).filter((a) => a && typeof a.name === 'string') : [];
  const wired = new Map(client.map((c) => [c.name, c]));
  const acts: CandidateAct[] = STUDIO_SKILL.acts.filter((a) => wired.has(a.name)).map((a) => ({
    name: a.name, title: a.title ?? a.name, phrases: a.phrases,
    slots: Object.entries(a.slots ?? {}).map(([name, s]) => {
      const declared = (s.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
      const runtime = (wired.get(a.name)!.slots?.[name]?.options ?? []).filter((o): o is string => typeof o === 'string').slice(0, 100);
      const options = declared.length ? declared : runtime;
      return { name, type: s.type, ...(options.length && s.type === 'choice' ? { options } : {}) };
    }),
  }));
  if (!acts.length) return { status: 200, body: { act: null, slots: {} } };

  const hint = typeof body.hint === 'string' && acts.some((a) => a.name === body.hint) ? body.hint : undefined;
  let spent: { usage: Usage; costMicros: number } = { usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }, costMicros: 0 };
  let out: Record<string, unknown> = { act: null, slots: {} };
  try {
    const r = await (deps.choose ?? claudeChooser)({ phrase, acts, appName: `the Entoli dashboard, for the app "${app.name}" (${app.repo ?? 'no repository'})`, ...(hint ? { hint } : {}) });
    spent = r;
    out = { ...admit(r.choice, acts) };
  } catch (e) {
    console.error('[studio] model call failed', e);
    return { status: 503, body: { error: 'The voice tool is unavailable; try again.' } };
  }
  const u = await meter(db, app.id, { tool: 1, modelCalls: 1, tokensIn: spent.usage.tokensIn, tokensOut: spent.usage.tokensOut, costMicros: spent.costMicros });
  return { status: 200, body: { ...out, toolTurns: u.toolTurns, quota: plan.voiceToolTurns } };
}


export { STUDIO_SKILL, pickFeatures } from './studio-skill';
