/**
 * Always-on voice for the dashboard (L2 plan).
 *
 *   mintSession   checks owner, plan and the month's minutes, then asks the
 *                 provider for a SHORT-LIVED key. The real provider key never
 *                 leaves the server.
 *   heartbeat     the browser reports each stretch of live audio; the server
 *                 meters it and says how many seconds are left.
 *
 * The realtime model is ears and mouth: it is created without auto-responses,
 * so it can only say what Entoli tells it to say.
 */
import type { DB } from '@/db';
import { getApp, getUsage, meter } from './apps';
import { PLANS } from './plans';
import { hit } from './ratelimit';

/** One live session at most this long, and it turns itself off after this much silence: a mic left on cannot burn the month. */
export const SESSION_SECONDS = 10 * 60;
export const IDLE_SECONDS = 3 * 60;
/** A heartbeat may claim at most this much, so one call cannot burn a whole month. */
export const MAX_BEAT_SECONDS = 70;
const MODEL = process.env.VOICE_MODEL ?? 'gpt-realtime';

export type VoiceResult = { status: number; body: Record<string, unknown> };
type Fetch = typeof fetch;

export const voiceConfigured = () => (process.env.VOICE_PROVIDER ?? 'openai') === 'openai' && !!process.env.OPENAI_API_KEY;

export async function mintSession(db: DB, userId: string, body: { appId?: unknown }, deps: { fetch?: Fetch } = {}): Promise<VoiceResult> {
  const app = typeof body.appId === 'string' ? await getApp(db, userId, body.appId) : null;
  if (!app) return { status: 404, body: { error: 'app not found' } };
  const plan = PLANS[app.plan];
  if (!plan.liveMinutes) return { status: 402, body: { error: 'Always-on voice is part of the L2 plan.' } };
  if (!(await hit(db, `voice-user:${userId}`, 40, 3_600_000)).ok) return { status: 429, body: { error: 'Too many voice sessions this hour.' } };
  if (!(await hit(db, `voice-session:${app.id}`, 20, 3_600_000)).ok) return { status: 429, body: { error: 'Too many voice sessions this hour.' } };
  const usage = await getUsage(db, app.id);
  const remaining = plan.liveMinutes * 60 - usage.liveSeconds;
  if (remaining <= 0) return { status: 402, body: { error: `This month's ${plan.liveMinutes} live-voice minutes are used. Typing and one-at-a-time instructions still work; it resets on the 1st.` } };

  const provider = process.env.VOICE_PROVIDER ?? 'openai';
  if (provider !== 'openai') return { status: 501, body: { error: `Voice provider "${provider}" is not built yet.` } };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { status: 200, body: { provider: null, reason: 'voice provider not configured', remainingSeconds: remaining } };

  const f = deps.fetch ?? fetch;
  const res = await f('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 120 },
      session: {
        type: 'realtime',
        model: MODEL,
        instructions: 'You are the voice of the Entoli dashboard. You never answer on your own and never add words: you only say, word for word, what you are told to say.',
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            // The model hears and stops talking when interrupted, but never replies by itself.
            turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
          },
          output: { voice: 'marin' },
        },
      },
    }),
  });
  if (!res.ok) {
    console.error('[voice] provider refused the session', res.status);
    return { status: 502, body: { error: 'The voice provider is unavailable; try again.' } };
  }
  const secret = (await res.json()) as { value?: string };
  if (!secret.value) return { status: 502, body: { error: 'The voice provider returned no key.' } };
  return { status: 200, body: { provider: 'openai', value: secret.value, model: MODEL, remainingSeconds: remaining, maxSessionSeconds: SESSION_SECONDS, idleSeconds: IDLE_SECONDS, heartbeatSeconds: 30 } };
}

export async function heartbeat(db: DB, userId: string, body: { appId?: unknown; seconds?: unknown }): Promise<VoiceResult> {
  const app = typeof body.appId === 'string' ? await getApp(db, userId, body.appId) : null;
  if (!app) return { status: 404, body: { error: 'app not found' } };
  const plan = PLANS[app.plan];
  if (!plan.liveMinutes) return { status: 402, body: { error: 'Always-on voice is part of the L2 plan.' } };
  const n = typeof body.seconds === 'number' && Number.isFinite(body.seconds) ? Math.floor(body.seconds) : 0;
  if (n < 1) return { status: 400, body: { error: 'seconds must be a positive number' } };
  if (!(await hit(db, `voice-beat:${app.id}`, 6, 60_000)).ok) return { status: 429, body: { error: 'Heartbeats too frequent.' } };
  const u = await meter(db, app.id, { live: Math.min(n, MAX_BEAT_SECONDS) });
  const remaining = Math.max(0, plan.liveMinutes * 60 - u.liveSeconds);
  return { status: 200, body: { remainingSeconds: remaining, stop: remaining === 0 } };
}
