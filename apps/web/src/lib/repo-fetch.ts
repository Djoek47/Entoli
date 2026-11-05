/**
 * Fetch a repository read-only for analysis: one tarball of the default
 * branch, size-capped, extracted to a temp directory with only source files
 * (no symlinks, no node_modules, no paths outside the directory).
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as extract } from 'tar';
import { installationToken } from './github';

const KEEP = /\.(tsx?|jsx?|mjs|vue)$|(^|\/)package\.json$/;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor)\//;
export const MAX_TARBALL_BYTES = 80 * 1024 * 1024;

export type Fetched = { dir: string; bytes: number; cleanup(): Promise<void> };

type Fetch = typeof fetch;

export async function fetchRepo(repo: string, opts: { installationId?: string | null; fetch?: Fetch; maxBytes?: number } = {}): Promise<Fetched> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`Not a repository: ${repo}`);
  const f = opts.fetch ?? fetch;
  const max = opts.maxBytes ?? MAX_TARBALL_BYTES;
  let res: Response;
  if (opts.installationId) {
    const token = await installationToken(opts.installationId, { repo });
    res = await f(`https://api.github.com/repos/${repo}/tarball`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'entoli' }, redirect: 'follow' });
  } else {
    res = await f(`https://codeload.github.com/${repo}/tar.gz/HEAD`, { headers: { 'user-agent': 'entoli' }, redirect: 'follow' });
  }
  if (res.status === 404) throw new Error(opts.installationId ? 'Repository not found for this installation.' : 'Repository not found. If it is private, connect it with the GitHub App.');
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new Error(`Repository archive is ${(declared / 1e6).toFixed(0)} MB; the limit is ${(max / 1e6).toFixed(0)} MB.`);

  const dir = await mkdtemp(join(tmpdir(), 'entoli-repo-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const archive = join(dir, '..', `${dir.split(/[/\\]/).pop()}.tar.gz`);
  try {
    let bytes = 0;
    const out = createWriteStream(archive);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { await reader.cancel(); out.destroy(); throw new Error(`Repository archive is over the ${(max / 1e6).toFixed(0)} MB limit.`); }
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    await extract({
      file: archive,
      cwd: dir,
      strip: 1,
      filter: (path, entry) => {
        const type = 'type' in entry ? entry.type : entry.isDirectory() ? 'Directory' : 'File';
        if (type === 'Directory') return !SKIP.test(`${path}/`);
        return type === 'File' && KEEP.test(path) && !SKIP.test(path);
      },
    });
    await rm(archive, { force: true });
    return { dir, bytes, cleanup };
  } catch (e) {
    await rm(archive, { force: true });
    await cleanup();
    throw e;
  }
}
