import { beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { checkPreviewUrl, createApp, upsertUser } from '@/lib/apps';
import { listRuns, parseReport, storeReport } from '@/lib/test-runs';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });

describe('preview URL guard (server-side browser)', () => {
  it('allows public https only in production', () => {
    expect(checkPreviewUrl('https://my-app.vercel.app', true)).toBeNull();
    for (const bad of ['http://my-app.com', 'https://localhost:3000', 'https://169.254.169.254/latest', 'https://10.0.0.5', 'https://192.168.1.1', 'https://172.20.0.1', 'https://[::1]/', 'https://db.internal', 'https://2130706433', 'nope']) {
      expect(checkPreviewUrl(bad, true), bad).not.toBeNull();
    }
    expect(checkPreviewUrl('http://localhost:5173', false)).toBeNull();
  });
});

describe('reports', () => {
  const good = { url: 'https://x.app', coverage: 92, checked: 12, verified: 11, broken: [{ id: 'a', title: 'Export', kind: 'button', status: 'broken', reason: 'not found' }], unchecked: [], ms: 900, startedAt: '2026-11-05T10:00:00Z', nodes: [] };

  it('accepts an entoli-test report and rejects anything else', () => {
    expect(parseReport(good)).toMatchObject({ coverage: 92, verified: 11, source: 'ci', broken: [{ title: 'Export', status: 'broken' }] });
    expect(parseReport({ ...good, coverage: 140 })).toBeNull();
    expect(parseReport({ ...good, verified: 20 })).toBeNull();
    expect(parseReport({ ...good, broken: 'x' })).toBeNull();
    expect(parseReport(null)).toBeNull();
  });

  it('stores runs per app, newest first', async () => {
    const u = await upsertUser(db, { githubId: 'tr', login: 't' });
    const { app } = await createApp(db, u.id, { name: 'T' });
    await storeReport(db, app.id, parseReport({ ...good, coverage: 50 })!);
    await storeReport(db, app.id, parseReport(good)!);
    const runs = await listRuns(db, app.id);
    expect(runs.map((r) => r.coverage)).toEqual([92, 50]);
  });
});
