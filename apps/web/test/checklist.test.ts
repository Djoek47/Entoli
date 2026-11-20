import { beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { integrations } from '@/db/schema';
import { checklist } from '@/lib/checklist';
import { createApp, getApp, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { startBlank } from '@/lib/project';
import { createMcpToken } from '@/lib/mcp';
import raw from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });
const user = () => upsertUser(db, { githubId: `ck${Math.random()}`, login: 'dev' });

describe('getting started', () => {
  it('walks a repo app from nothing to shipped, one real step at a time', async () => {
    const u = await user();
    const { app } = await createApp(db, u.id, { name: 'Walk' });
    const get = async () => (await getApp(db, u.id, app.id))!;
    let c = await checklist(db, await get());
    expect(c.next?.id).toBe('start');
    expect(c.doneCount).toBe(0);

    await db.update((await import('@/db/schema')).apps).set({ repo: 'acme/walk' }).where((await import('drizzle-orm')).eq((await import('@/db/schema')).apps.id, app.id));
    expect((await checklist(db, await get())).next?.id).toBe('analyze');

    expect((await saveSkill(db, u.id, app.id, raw, 'draft')).ok).toBe(true);
    expect((await checklist(db, await get())).next?.id).toBe('expose');

    await setPlan(db, app.id, 'l2', { id: 's', status: 'active' });
    const { proposeFor, acceptProposal } = await import('@/lib/proposal');
    await proposeFor(db, await get());
    await acceptProposal(db, await get());
    expect((await checklist(db, await get())).next?.id).toBe('build');

    await createMcpToken(db, u.id, app.id, 'agent');
    expect((await checklist(db, await get())).next?.id).toBe('try');

    const [row] = await db.insert(integrations).values({ appId: app.id, answers: {}, changes: [], status: 'pr_opened' }).returning();
    expect(row).toBeTruthy();
    const { sandboxes } = await import('@/db/schema');
    await db.insert(sandboxes).values({ appId: app.id, provider: 'local', status: 'stopped', log: [] });
    c = await checklist(db, await get());
    expect(c.next?.id).toBe('publish');
    expect(c.doneCount).toBe(6);

    await saveSkill(db, u.id, app.id, raw, 'published');
    c = await checklist(db, await get());
    expect(c.next).toBeNull();
    expect(c.doneCount).toBe(c.steps.length);
  });

  it('starts a project further along: the skill and the starter already exist', async () => {
    const u = await user();
    const r = await startBlank(db, u.id, { name: 'P', description: 'x' }, { drafter: async () => ({ ...(raw as object), app: { name: 'P' } }) });
    const c = await checklist(db, (await getApp(db, u.id, r.appId))!);
    expect(c.steps[0]).toMatchObject({ id: 'start', done: true });
    expect(c.next?.id).toBe('expose');
    expect(c.steps.find((s) => s.id === 'build')!.title).toBe('Connect your coding agent');
  });
});
