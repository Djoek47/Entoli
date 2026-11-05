import { beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { appByKey, createApp, createKey, getApp, getUsage, listApps, listKeys, meter, parseRepo, revokeKey, saveSkill, upsertUser } from '@/lib/apps';
import { hashKey, looksLikeKey } from '@/lib/keys';
import { apiKeys } from '@/db/schema';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });

describe('apps', () => {
  it('scopes every app to its owner', async () => {
    const a = await upsertUser(db, { githubId: '1', login: 'ana' });
    const b = await upsertUser(db, { githubId: '2', login: 'bo' });
    const { app } = await createApp(db, a.id, { name: 'Notes', repo: 'https://github.com/ana/notes.git' });
    expect(app.repo).toBe('ana/notes');
    expect(await getApp(db, b.id, app.id)).toBeNull();
    expect((await listApps(db, b.id))).toHaveLength(0);
    expect((await listApps(db, a.id)).map((x) => x.name)).toEqual(['Notes']);
    await expect(createApp(db, a.id, { name: 'X', repo: 'not a repo!' })).rejects.toThrow(/owner\/name/);
  });

  it('upserts users by GitHub id', async () => {
    const u1 = await upsertUser(db, { githubId: '9', login: 'old' });
    const u2 = await upsertUser(db, { githubId: '9', login: 'new' });
    expect(u2.id).toBe(u1.id);
    expect(u2.login).toBe('new');
  });

  it('parses repository references', () => {
    expect(parseRepo('github.com/Djoek47/entoli')).toBe('Djoek47/entoli');
    expect(parseRepo('Djoek47/entoli/')).toBe('Djoek47/entoli');
    expect(parseRepo('../etc/passwd')).toBeNull();
  });
});

describe('skills', () => {
  it('saves only valid skills, and L2 publishes only on the L2 plan', async () => {
    const u = await upsertUser(db, { githubId: '3', login: 'cy' });
    const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
    expect(await saveSkill(db, u.id, app.id, { nope: 1 })).toMatchObject({ ok: false });
    expect(await saveSkill(db, u.id, app.id, skill)).toMatchObject({ ok: true });
    const pub = await saveSkill(db, u.id, app.id, skill, 'published');
    expect(pub.ok).toBe(false);
    if (!pub.ok) expect(pub.errors[0]).toMatch(/L2 plan/);
    const other = await upsertUser(db, { githubId: '4', login: 'dee' });
    expect(await saveSkill(db, other.id, app.id, skill)).toEqual({ ok: false, errors: ['App not found.'] });
  });
});

describe('keys', () => {
  it('shows the key once, stores only its hash, and revocation works', async () => {
    const u = await upsertUser(db, { githubId: '5', login: 'eve' });
    const { app } = await createApp(db, u.id, { name: 'K' });
    const { key } = await createKey(db, u.id, app.id, 'web');
    expect(looksLikeKey(key)).toBe(true);
    const stored = await db.select().from(apiKeys);
    expect(stored.some((r) => r.hash === hashKey(key))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(key);
    expect((await appByKey(db, key))?.id).toBe(app.id);
    const [k] = await listKeys(db, u.id, app.id);
    expect(k!.prefix).toBe(key.slice(0, 12));
    await revokeKey(db, u.id, app.id, k!.id);
    expect(await appByKey(db, key)).toBeNull();
    expect(await appByKey(db, 'ek_live_short')).toBeNull();
  });
});

describe('usage', () => {
  it('meters atomically per app per month', async () => {
    const u = await upsertUser(db, { githubId: '6', login: 'fin' });
    const { app } = await createApp(db, u.id, { name: 'U' });
    await Promise.all([meter(db, app.id, { text: 1 }), meter(db, app.id, { text: 1 }), meter(db, app.id, { voice: 1, modelCalls: 1, tokensIn: 100, tokensOut: 20, costMicros: 450 })]);
    const r = await getUsage(db, app.id);
    expect(r).toMatchObject({ textIntents: 2, voiceTurns: 1, modelCalls: 1, tokensIn: 100, tokensOut: 20, costMicros: 450 });
  });
});
