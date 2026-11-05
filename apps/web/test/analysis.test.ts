import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar } from 'tar';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { createApp, getApp, upsertUser } from '@/lib/apps';
import { listAnalyses, queueAnalysis, runAnalysis } from '@/lib/analysis';
import { fetchRepo } from '@/lib/repo-fetch';

const fixture = fileURLToPath(new URL('../../../packages/analyzer/test/fixtures/rr-app', import.meta.url));
let db: DB;
beforeAll(async () => { db = await memoryDb(); });

/** A GitHub-style tarball: everything under one top-level folder. */
async function tarball(extra?: (root: string) => Promise<void>): Promise<Buffer> {
  const work = await mkdtemp(join(tmpdir(), 'entoli-test-'));
  const top = join(work, 'acme-notes-abc123');
  await cp(fixture, top, { recursive: true });
  await mkdir(join(top, 'node_modules', 'evil'), { recursive: true });
  await writeFile(join(top, 'node_modules', 'evil', 'index.js'), 'bad');
  await writeFile(join(top, 'README.md'), 'not code');
  await extra?.(top);
  const file = join(work, 'repo.tar.gz');
  await createTar({ gzip: true, file, cwd: work, portable: true }, ['acme-notes-abc123']);
  const buf = await readFile(file);
  await rm(work, { recursive: true, force: true });
  return buf;
}

const serve = (buf: Buffer, status = 200) => (async (url: string) => {
  expect(url).toBe('https://codeload.github.com/acme/notes/tar.gz/HEAD');
  return new Response(status === 200 ? new Uint8Array(buf) : null, { status, headers: { 'content-length': String(buf.length) } });
}) as unknown as typeof fetch;

describe('fetchRepo', () => {
  it('extracts only source files, strips the top folder, drops symlinks and node_modules', async () => {
    const buf = await tarball(async (top) => { await symlink('/etc/passwd', join(top, 'src', 'link.ts')); });
    const r = await fetchRepo('acme/notes', { fetch: serve(buf) });
    try {
      expect(existsSync(join(r.dir, 'src', 'App.tsx'))).toBe(true);
      expect(existsSync(join(r.dir, 'package.json'))).toBe(true);
      expect(existsSync(join(r.dir, 'README.md'))).toBe(false);
      expect(existsSync(join(r.dir, 'node_modules'))).toBe(false);
      expect(existsSync(join(r.dir, 'src', 'link.ts'))).toBe(false);
      expect(r.bytes).toBe(buf.length);
    } finally {
      await r.cleanup();
    }
    expect(existsSync(r.dir)).toBe(false);
  });

  it('refuses oversized archives, missing repos and bad names', async () => {
    const buf = await tarball();
    await expect(fetchRepo('acme/notes', { fetch: serve(buf), maxBytes: 100 })).rejects.toThrow(/limit/);
    await expect(fetchRepo('acme/notes', { fetch: serve(buf, 404) })).rejects.toThrow(/not found/);
    await expect(fetchRepo('../../etc', { fetch: serve(buf) })).rejects.toThrow(/Not a repository/);
  });
});

describe('analysis job', () => {
  it('runs the analyzer on the fetched repo and saves a draft skill', async () => {
    const u = await upsertUser(db, { githubId: 'a1', login: 'ana' });
    const { app } = await createApp(db, u.id, { name: 'Notes', repo: 'acme/notes' });
    const q = await queueAnalysis(db, app);
    if ('error' in q) throw new Error(q.error);
    expect(await queueAnalysis(db, app)).toEqual({ error: 'An analysis is already running for this app.' });

    const buf = await tarball();
    await runAnalysis(db, app, q.id, (a) => fetchRepo(a.repo!, { fetch: serve(buf) }));

    const [run] = await listAnalyses(db, app.id);
    expect(run).toMatchObject({ status: 'done', usedModel: false, costMicros: 0 });
    expect(run!.filesScanned).toBe(3);
    expect(run!.log.join('\n')).toMatch(/Saved as a draft/);
    const after = (await getApp(db, u.id, app.id))!;
    expect(after.skillStatus).toBe('draft');
    expect((after.skill as { app: { name: string; repo: string } }).app).toEqual({ name: 'Notes', repo: 'acme/notes' });
    expect((after.skill as { acts: { name: string }[] }).acts.map((a) => a.name)).toContain('createNote');
  });

  it('records a failure without throwing', async () => {
    const u = await upsertUser(db, { githubId: 'a2', login: 'bo' });
    const { app } = await createApp(db, u.id, { name: 'Gone', repo: 'acme/notes' });
    const q = await queueAnalysis(db, app);
    if ('error' in q) throw new Error(q.error);
    await runAnalysis(db, app, q.id, async () => { throw new Error('Repository not found.'); });
    const [run] = await listAnalyses(db, app.id);
    expect(run).toMatchObject({ status: 'failed', error: 'Repository not found.' });
  });

  it('needs a repository', async () => {
    const u = await upsertUser(db, { githubId: 'a3', login: 'cy' });
    const { app } = await createApp(db, u.id, { name: 'NoRepo' });
    expect(await queueAnalysis(db, app)).toEqual({ error: 'Connect a repository first.' });
  });
});
