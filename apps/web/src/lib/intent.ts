/**
 * POST /api/intent — the model fallback for phrases the SDK could not resolve
 * on the device, and the meter for voice turns.
 *
 * The model CHOOSES; it never invents. Candidates are the acts that are both
 * in the app's published skill and wired in the calling client. The act name
 * is an enum in the output schema, slot names are an enum, and both are
 * checked again here. The SDK then puts the choice under the commit contract
 * like any other (a model's choice always waits for a yes).
 */
import { askJson, AiError, hasAnthropicKey, type Usage } from '@entoli/analyzer';
import { actLayer, type Skill, type SkillAct, type SlotType } from '@entoli/sdk/skill';
import type { DB } from '@/db';
import { appByKey, getUsage, meter, skillOf } from './apps';
import { freeAppAllowed } from './billing';
import { PLANS, SOFT_LIMIT_SHARE } from './plans';
import { hit } from './ratelimit';

export type IntentRequest = {
  phrase?: unknown;
  channel?: unknown;
  acts?: unknown;
  /** The act the device matched, if any. */
  hint?: unknown;
};

type ClientAct = { name: string; slots: Record<string, { type: SlotType; options?: string[] }> };

export type Choice = { act: string | null; slots: Record<string, string>; say?: string };
export type Chooser = (input: { phrase: string; acts: CandidateAct[]; appName: string; hint?: string }) => Promise<{ choice: Choice; usage: Usage; costMicros: number }>;
export type CandidateAct = { name: string; title: string; description?: string; phrases: string[]; slots: { name: string; type: SlotType; options?: string[] }[] };

export type IntentResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export const INTENT_RATE_PER_MIN = Number(process.env.INTENT_RATE_PER_MIN ?? 120);
const MAX_PHRASE = 500;

const SYSTEM = `You route a person's request to one of an app's declared actions. You receive the request and the list of actions the app allows. Pick the single action the request asks for, or "none" if no action fits or the request is not asking for any of them (a question, a remark, a refusal). Fill a slot only with a value the person actually said or clearly meant; for slots with options, use one of the options exactly. Leave out slots you are unsure about: the app will ask. Never pick an action just because it is the closest one.
Also write "say": one or two short, plain sentences spoken back to the person. If you picked an action, say what you are about to do (the app still shows it and asks for a yes when needed; never claim it is done). If not, answer briefly or say what you can do instead, using only the actions listed. The device's own match, if any, is given as a hint; it is usually right.`;

function parseClientActs(raw: unknown): ClientAct[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ClientAct[] = [];
  for (const a of raw.slice(0, 200)) {
    if (!a || typeof a !== 'object' || typeof (a as { name?: unknown }).name !== 'string') continue;
    const slots: ClientAct['slots'] = {};
    const s = (a as { slots?: unknown }).slots;
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const opts = (v as { options?: unknown }).options;
        slots[k] = { type: (v as { type: SlotType }).type, ...(Array.isArray(opts) ? { options: opts.filter((o): o is string => typeof o === 'string').slice(0, 100) } : {}) };
      }
    }
    out.push({ name: (a as { name: string }).name, slots });
  }
  return out;
}

/** The skill's acts that the client has wired, with runtime options for choice slots the skill leaves open. */
export function candidates(skill: Skill, client: ClientAct[]): CandidateAct[] {
  const wired = new Map(client.map((c) => [c.name, c]));
  return skill.acts.filter((a) => wired.has(a.name) && actLayer(skill, a) === 'L2').map((a: SkillAct) => ({
    name: a.name,
    title: a.title ?? a.name,
    ...(a.description ? { description: a.description } : {}),
    phrases: a.phrases.slice(0, 8),
    slots: Object.entries(a.slots ?? {}).map(([name, s]) => {
      const declared = (s.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
      const runtime = wired.get(a.name)!.slots[name]?.options ?? [];
      const options = declared.length ? declared : runtime;
      return { name, type: s.type, ...(options.length && (s.type === 'choice' || s.type === 'person') ? { options } : {}) };
    }),
  }));
}

export const claudeChooser: Chooser = async ({ phrase, acts, appName, hint }) => {
  const slotNames = [...new Set(acts.flatMap((a) => a.slots.map((s) => s.name)))];
  const schema = {
    type: 'object', additionalProperties: false, required: ['act', 'slots', 'say'],
    properties: {
      say: { type: 'string' },
      act: { type: 'string', enum: [...acts.map((a) => a.name), 'none'] },
      slots: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: slotNames.length ? { type: 'string', enum: slotNames } : { type: 'string' }, value: { type: 'string' } } },
      },
    },
  };
  const r = await askJson<{ act: string; slots: { name: string; value: string }[]; say: string }>({
    system: SYSTEM,
    prompt: `App: ${appName}\nActions:\n${JSON.stringify(acts)}\n${hint ? `Device match (hint): ${hint}\n` : ''}\nRequest: ${JSON.stringify(phrase)}`,
    schema,
    effort: 'low',
    maxTokens: 2048,
  });
  const slots: Record<string, string> = {};
  for (const s of r.data.slots) slots[s.name] = s.value;
  return { choice: { act: r.data.act === 'none' ? null : r.data.act, slots, say: r.data.say.slice(0, 400) }, usage: r.usage, costMicros: r.costMicros };
};

/** Keep only what the chosen act declares; option slots must use an option. */
export function admit(choice: Choice, acts: CandidateAct[]): Choice {
  const say = typeof choice.say === 'string' && choice.say.trim() ? { say: choice.say.trim().slice(0, 400) } : {};
  const act = acts.find((a) => a.name === choice.act);
  if (!act) return { act: null, slots: {}, ...say };
  const slots: Record<string, string> = {};
  for (const s of act.slots) {
    const v = choice.slots[s.name];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (s.options?.length && !s.options.includes(v)) {
      const ci = s.options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (ci) slots[s.name] = ci;
      continue;
    }
    slots[s.name] = v.trim().slice(0, 500);
  }
  return { act: act.name, slots, ...say };
}

function originAllowed(allowed: string[], origin: string | null): boolean {
  if (!allowed.length) return true;
  if (!origin) return false;
  return allowed.some((a) => a === origin || (a.startsWith('*.') && new URL(origin).hostname.endsWith(a.slice(1))));
}

export async function handleIntent(db: DB, input: { key: string | null; origin: string | null; body: IntentRequest }, deps: { choose?: Chooser; modelAvailable?: boolean } = {}): Promise<IntentResult> {
  const app = input.key ? await appByKey(db, input.key) : null;
  if (!app) return { status: 401, body: { error: 'invalid or revoked app key' } };
  let allowed = true;
  try { allowed = originAllowed(app.allowedOrigins, input.origin); } catch { allowed = false; }
  if (!allowed) return { status: 403, body: { error: 'origin not allowed for this key' } };

  const rl = await hit(db, `intent:${app.id}`, INTENT_RATE_PER_MIN);
  if (!rl.ok) return { status: 429, body: { error: 'rate limit' }, headers: { 'retry-after': String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)) } };

  const { phrase, channel } = input.body;
  if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > MAX_PHRASE) return { status: 400, body: { error: `phrase must be 1-${MAX_PHRASE} characters` } };
  if (channel !== 'text' && channel !== 'voice') return { status: 400, body: { error: 'channel must be "text" or "voice"' } };

  const plan = PLANS[app.plan];
  // Layer 1 has no Entoli AI: the device answers, or the developer's own resolver.
  if (!plan.ai) return { status: 402, body: { error: 'Entoli AI (Layer 2) is part of the L2 plan. On Layer 1 phrases resolve on the device, or connect your own AI with the resolver option.', plan: plan.id } };
  if (!(await freeAppAllowed(db, app))) return { status: 402, body: { error: 'The Developer plan covers one app. Upgrade this app in the dashboard.', plan: plan.id } };
  const usage = await getUsage(db, app.id);
  if (plan.hardLimit && usage.textIntents >= plan.includedText) {
    return { status: 402, body: { error: `Monthly limit of ${plan.includedText.toLocaleString()} intents reached on the ${plan.name} plan. On-device matching keeps working.`, plan: plan.id } };
  }
  const usageHeaders = (u: { textIntents: number; voiceTurns: number }) => {
    const h: Record<string, string> = { 'x-entoli-text-intents': `${u.textIntents}/${plan.includedText}`, 'x-entoli-voice-turns': String(u.voiceTurns) };
    if (u.textIntents >= plan.includedText * SOFT_LIMIT_SHARE) h['x-entoli-warning'] = u.textIntents >= plan.includedText ? 'over included intents (billed as overage)' : 'over 80% of included intents';
    return h;
  };

  const skill = skillOf(app);
  if (!skill || app.skillStatus !== 'published') return { status: 409, body: { error: 'Publish this app\'s skill in the dashboard first.' } };
  const client = parseClientActs(input.body.acts);
  if (!client) return { status: 400, body: { error: 'acts must be an array' } };
  const acts = candidates(skill, client);

  const modelAvailable = deps.modelAvailable ?? hasAnthropicKey();
  if (!acts.length || !modelAvailable) {
    return { status: 200, body: { act: null, slots: {}, reason: !acts.length ? 'no wired acts' : 'model unavailable' } };
  }

  const choose = deps.choose ?? claudeChooser;
  let choice: Choice = { act: null, slots: {} };
  let spent: { usage: Usage; costMicros: number } = { usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }, costMicros: 0 };
  try {
    const hint = typeof input.body.hint === 'string' && acts.some((a) => a.name === input.body.hint) ? input.body.hint : undefined;
    const r = await choose({ phrase: phrase.trim(), acts, appName: skill.app.name, ...(hint ? { hint } : {}) });
    choice = admit(r.choice, acts);
    spent = r;
  } catch (e) {
    if (e instanceof AiError) {
      if (e.usage) spent = { usage: e.usage, costMicros: 0 };
      if (e.reason !== 'refusal' && e.reason !== 'invalid_json' && e.reason !== 'truncated') return { status: 503, body: { error: 'model unavailable, try again' } };
    } else {
      console.error('[intent] model call failed', e);
      return { status: 503, body: { error: 'model unavailable, try again' } };
    }
  }
  const u = await meter(db, app.id, {
    ...(channel === 'voice' ? { voice: 1 } : { text: 1 }),
    modelCalls: 1, tokensIn: spent.usage.tokensIn, tokensOut: spent.usage.tokensOut, costMicros: spent.costMicros,
  });
  return { status: 200, body: { act: choice.act, slots: choice.slots, ...(choice.say ? { say: choice.say } : {}) }, headers: usageHeaders(u) };
}
