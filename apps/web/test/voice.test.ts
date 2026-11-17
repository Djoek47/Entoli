import { beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { createApp, getUsage, meter, setPlan, upsertUser } from '@/lib/apps';
import { heartbeat, IDLE_SECONDS, MAX_BEAT_SECONDS, mintSession, SESSION_SECONDS } from '@/lib/voice';

let db: DB;
beforeAll(async () => { db = await memoryDb(); process.env.OPENAI_API_KEY = 'sk-real-server-key'; });

async function setup(plan: 'developer' | 'l1' | 'l2') {
  const u = await upsertUser(db, { githubId: `v${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
  await setPlan(db, app.id, plan, { id: 's', status: 'active' });
  return { user: u, app };
}
const provider = (status = 200, body: unknown = { value: 'ek_short', expires_at: 1 }) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('POST /api/voice/session', () => {
  it('mints a short-lived key with auto-replies off, and never returns the real key', async () => {
    const { user, app } = await setup('l2');
    const f = provider();
    const r = await mintSession(db, user.id, { appId: app.id }, { fetch: f });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'openai', value: 'ek_short', model: 'gpt-realtime', remainingSeconds: 7200, heartbeatSeconds: 30 });
    expect(JSON.stringify(r.body)).not.toContain('sk-real-server-key');
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-real-server-key');
    const sent = JSON.parse(String(init.body));
    expect(sent.session.audio.input.turn_detection).toEqual({ type: 'server_vad', create_response: false, interrupt_response: true });
    expect(sent.expires_after.seconds).toBe(120);
  });

  it('is L2 only, owner only, and stops at the monthly minutes', async () => {
    for (const plan of ['developer', 'l1'] as const) {
      const { user, app } = await setup(plan);
      expect((await mintSession(db, user.id, { appId: app.id }, { fetch: provider() })).status).toBe(402);
    }
    const { user, app } = await setup('l2');
    expect((await mintSession(db, (await upsertUser(db, { githubId: 'other', login: 'o' })).id, { appId: app.id }, { fetch: provider() })).status).toBe(404);
    await meter(db, app.id, { live: 7200 });
    const r = await mintSession(db, user.id, { appId: app.id }, { fetch: provider() });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/120 live-voice minutes/);
  });

  it('survives a provider failure without leaking details', async () => {
    const { user, app } = await setup('l2');
    const r = await mintSession(db, user.id, { appId: app.id }, { fetch: provider(500, { error: 'secret detail' }) });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret detail');
  });

  it('says so when no provider key is configured', async () => {
    const { user, app } = await setup('l2');
    const keep = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    const r = await mintSession(db, user.id, { appId: app.id }, { fetch: provider() });
    process.env.OPENAI_API_KEY = keep;
    expect(r.body).toMatchObject({ provider: null, reason: 'voice provider not configured' });
  });
});

describe('POST /api/voice/heartbeat', () => {
  it('meters live seconds, caps a single claim, and tells the client when to stop', async () => {
    const { user, app } = await setup('l2');
    const a = await heartbeat(db, user.id, { appId: app.id, seconds: 30 });
    expect(a.body).toEqual({ remainingSeconds: 7170, stop: false });
    const b = await heartbeat(db, user.id, { appId: app.id, seconds: 100_000 });
    expect((await getUsage(db, app.id)).liveSeconds).toBe(30 + MAX_BEAT_SECONDS);
    expect(b.body.stop).toBe(false);
    await meter(db, app.id, { live: 7200 });
    expect((await heartbeat(db, user.id, { appId: app.id, seconds: 30 })).body).toEqual({ remainingSeconds: 0, stop: true });
  });

  it('rejects nonsense and strangers', async () => {
    const { user, app } = await setup('l2');
    expect((await heartbeat(db, user.id, { appId: app.id, seconds: -5 })).status).toBe(400);
    expect((await heartbeat(db, user.id, { appId: app.id, seconds: 'lots' })).status).toBe(400);
    expect((await heartbeat(db, (await upsertUser(db, { githubId: 'x2', login: 'x' })).id, { appId: app.id, seconds: 10 })).status).toBe(404);
    const free = await setup('developer');
    expect((await heartbeat(db, free.user.id, { appId: free.app.id, seconds: 10 })).status).toBe(402);
  });

  it('limits how often beats may arrive', async () => {
    const { user, app } = await setup('l2');
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await heartbeat(db, user.id, { appId: app.id, seconds: 1 })).status);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes.slice(6)).toEqual([429, 429]);
  });
});

describe('cost and abuse controls', () => {
  it('tells the client the session cap and the idle timeout, so a mic left on cannot burn the month', async () => {
    const { user, app } = await setup('l2');
    const r = await mintSession(db, user.id, { appId: app.id }, { fetch: provider() });
    expect(r.body).toMatchObject({ maxSessionSeconds: SESSION_SECONDS, idleSeconds: IDLE_SECONDS });
    expect(SESSION_SECONDS).toBeLessThanOrEqual(10 * 60);
    expect(IDLE_SECONDS).toBeLessThanOrEqual(3 * 60);
  });

  it('limits sessions per person across all their apps', async () => {
    const { user, app } = await setup('l2');
    const second = await createApp(db, user.id, { name: 'Second' });
    await setPlan(db, second.app.id, 'l2', { id: 's2', status: 'active' });
    const f = provider();
    let denied = 0;
    for (let i = 0; i < 45; i++) {
      const r = await mintSession(db, user.id, { appId: i % 2 ? app.id : second.app.id }, { fetch: f });
      if (r.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThanOrEqual(40);
  });
});

