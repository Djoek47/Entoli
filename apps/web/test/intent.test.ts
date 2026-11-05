import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { apps } from '@/db/schema';
import { createApp, createKey, getUsage, meter, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { candidates, handleIntent, type Chooser } from '@/lib/intent';
import { hit } from '@/lib/ratelimit';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });

const clientActs = [
  { name: 'note.create', slots: { text: { type: 'freeText' } } },
  { name: 'note.delete', slots: { note: { type: 'choice', options: ['n1', 'n2'] } } },
  { name: 'settings.theme', slots: { theme: { type: 'choice', options: ['light', 'dark'] } } },
];

async function setup(plan: 'developer' | 'l1' | 'l2' = 'l2', publish = true) {
  const u = await upsertUser(db, { githubId: `u${Math.random()}`, login: 'dev' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
  await setPlan(db, app.id, 'l2');
  const r = await saveSkill(db, u.id, app.id, skill, publish ? 'published' : 'draft');
  if (!r.ok) throw new Error(r.errors.join());
  await setPlan(db, app.id, plan);
  const { key } = await createKey(db, u.id, app.id);
  return { app, key, user: u };
}

const fixed = (act: string | null, slots: Record<string, string> = {}): Chooser => vi.fn(async () => ({ choice: { act, slots }, usage: { tokensIn: 300, tokensOut: 40, cacheRead: 0, cacheWrite: 0 }, costMicros: 2000 }));
const call = (key: string | null, body: Record<string, unknown>, deps: Parameters<typeof handleIntent>[2] = {}, origin: string | null = null) =>
  handleIntent(db, { key, origin, body }, { modelAvailable: true, ...deps });

describe('/api/intent', () => {
  it('rejects bad keys and bad requests', async () => {
    const { key } = await setup();
    expect((await call('ek_live_nope', { phrase: 'x', channel: 'text', acts: [] })).status).toBe(401);
    expect((await call(null, { phrase: 'x', channel: 'text', acts: [] })).status).toBe(401);
    expect((await call(key, { phrase: '', channel: 'text', acts: [] })).status).toBe(400);
    expect((await call(key, { phrase: 'x'.repeat(501), channel: 'text', acts: [] })).status).toBe(400);
    expect((await call(key, { phrase: 'x', channel: 'fax', acts: [] })).status).toBe(400);
    expect((await call(key, { phrase: 'x', channel: 'text', acts: 'all' })).status).toBe(400);
  });

  it('needs a published skill', async () => {
    const { key } = await setup('l2', false);
    expect((await call(key, { phrase: 'x', channel: 'text', acts: clientActs })).status).toBe(409);
  });

  it('lets the model choose only among published AND wired acts, and admits slots', async () => {
    const { key, app } = await setup();
    const choose = fixed('settings.theme', { theme: 'Dark', extra: 'nope' });
    const r = await call(key, { phrase: 'make it look like midnight', channel: 'text', acts: clientActs }, { choose });
    expect(r).toMatchObject({ status: 200, body: { act: 'settings.theme', slots: { theme: 'dark' } } });
    const offered = (choose as unknown as { mock: { calls: [{ acts: { name: string }[] }][] } }).mock.calls[0]![0].acts.map((a) => a.name);
    expect(offered.sort()).toEqual(['note.create', 'note.delete', 'settings.theme']); // not nav/search/email: not wired here
    expect(r.headers!['x-entoli-text-intents']).toBe('1/100000');
    const u = await getUsage(db, app.id);
    expect(u).toMatchObject({ textIntents: 1, voiceTurns: 0, modelCalls: 1, tokensIn: 300, tokensOut: 40, costMicros: 2000 });
  });

  it('turns an invented act or an off-list option into nothing', async () => {
    const { key } = await setup();
    expect((await call(key, { phrase: 'delete my account', channel: 'text', acts: clientActs }, { choose: fixed('account.delete') })).body).toEqual({ act: null, slots: {} });
    const r = await call(key, { phrase: 'make it neon', channel: 'text', acts: clientActs }, { choose: fixed('settings.theme', { theme: 'neon' }) });
    expect(r.body).toEqual({ act: 'settings.theme', slots: {} });
    // Runtime options from the client fill choice slots the skill leaves open.
    const r2 = await call(key, { phrase: 'delete the second note', channel: 'text', acts: clientActs }, { choose: fixed('note.delete', { note: 'n2' }) });
    expect(r2.body).toEqual({ act: 'note.delete', slots: { note: 'n2' } });
  });

  it('answers "no match" without metering when the model is unavailable', async () => {
    const { key, app } = await setup();
    const r = await call(key, { phrase: 'hello', channel: 'text', acts: clientActs }, { modelAvailable: false });
    expect(r.body).toMatchObject({ act: null, reason: 'model unavailable' });
    expect((await getUsage(db, app.id)).textIntents).toBe(0);
  });

  it('Entoli AI is Layer 2: free and L1 apps are refused, the device answers for them', async () => {
    for (const plan of ['developer', 'l1'] as const) {
      const { key, app } = await setup(plan);
      const r = await call(key, { phrase: 'make it purple', channel: 'text', acts: clientActs }, { choose: fixed('settings.theme', { theme: 'dark' }) });
      expect(r.status).toBe(402);
      expect(r.body.error).toMatch(/L2 plan/);
      expect((await getUsage(db, app.id)).textIntents).toBe(0);
    }
  });

  it('meters AI voice turns separately from text, and returns what to say', async () => {
    const { key, app } = await setup('l2');
    const choose: Chooser = vi.fn(async () => ({ choice: { act: 'note.create', slots: { text: 'milk' }, say: 'Adding a note: milk.' }, usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 }, costMicros: 24 }));
    const r = await call(key, { phrase: 'remember milk', channel: 'voice', acts: clientActs, hint: 'note.create' }, { choose });
    expect(r.body).toEqual({ act: 'note.create', slots: { text: 'milk' }, say: 'Adding a note: milk.' });
    expect((choose as unknown as { mock: { calls: [{ hint?: string }][] } }).mock.calls[0]![0].hint).toBe('note.create');
    expect(await getUsage(db, app.id)).toMatchObject({ voiceTurns: 1, textIntents: 0 });
  });

  it('only offers the AI acts set to Layer 2', async () => {
    const { key, app, user } = await setup('l2');
    const mixed = { ...skill, layer: 'L2', acts: skill.acts.map((a) => (a.name === 'note.delete' ? { ...a, layer: 'L1' } : a.name === 'settings.email' ? { ...a, layer: 'off' } : a)) };
    expect((await saveSkill(db, user.id, app.id, mixed, 'published')).ok).toBe(true);
    const choose = fixed(null);
    await call(key, { phrase: 'x', channel: 'text', acts: [...clientActs, { name: 'settings.email', slots: {} }] }, { choose });
    const offered = (choose as unknown as { mock: { calls: [{ acts: { name: string }[] }][] } }).mock.calls[0]![0].acts.map((a) => a.name);
    expect(offered.sort()).toEqual(['note.create', 'settings.theme']);
  });

  it('warns L2 apps past 80% of their AI intents', async () => {
    const paid = await setup('l2');
    await meter(db, paid.app.id, { text: 85_000 });
    const r2 = await call(paid.key, { phrase: 'x', channel: 'text', acts: clientActs }, { choose: fixed(null) });
    expect(r2.status).toBe(200);
    expect(r2.headers!['x-entoli-warning']).toMatch(/80%/);
  });

  it('enforces allowed origins when set', async () => {
    const { key, app } = await setup();
    await db.update(apps).set({ allowedOrigins: ['https://fieldnotes.app', '*.vercel.app'] }).where(eq(apps.id, app.id));
    const body = { phrase: 'x', channel: 'text', acts: clientActs };
    expect((await call(key, body, { choose: fixed(null) }, 'https://evil.example')).status).toBe(403);
    expect((await call(key, body, { choose: fixed(null) }, null)).status).toBe(403);
    expect((await call(key, body, { choose: fixed(null) }, 'https://fieldnotes.app')).status).toBe(200);
    expect((await call(key, body, { choose: fixed(null) }, 'https://pr-7.vercel.app')).status).toBe(200);
  });
});

describe('rate limit and candidates', () => {
  it('counts per window', async () => {
    const now = 1_700_000_000_000;
    expect((await hit(db, 'k', 2, 60_000, now)).ok).toBe(true);
    expect((await hit(db, 'k', 2, 60_000, now + 1)).ok).toBe(true);
    expect((await hit(db, 'k', 2, 60_000, now + 2)).ok).toBe(false);
    expect((await hit(db, 'k', 2, 60_000, now + 60_000)).ok).toBe(true);
  });

  it('builds candidates from the skill, with runtime options only where the skill has none', () => {
    const c = candidates(skill as never, clientActs as never);
    expect(c.find((a) => a.name === 'settings.theme')!.slots[0]).toEqual({ name: 'theme', type: 'choice', options: ['light', 'dark'] });
    expect(c.find((a) => a.name === 'note.delete')!.slots[0]).toEqual({ name: 'note', type: 'choice', options: ['n1', 'n2'] });
  });
});
