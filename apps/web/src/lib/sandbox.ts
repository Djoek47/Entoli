/**
 * Where a developer's app runs while they test the Entoli layer.
 *
 * One interface, two providers:
 *   vercel  Vercel Sandbox (Firecracker microVMs): isolated, cheap, disposable. Production.
 *   local   a temp directory and child processes on THIS machine. Dev and tests only:
 *           it runs the developer's code, so it refuses to start in production.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

export type RunResult = { code: number; output: string };
export type SandboxFile = { path: string; content: string | Uint8Array };

export interface Sandbox {
  readonly id: string;
  writeFiles(files: SandboxFile[]): Promise<void>;
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult>;
  /** Start a long-running server on `port` and resolve with its URL once it answers. */
  serve(cmd: string, args: string[], port: number, opts?: { env?: Record<string, string>; readyMs?: number }): Promise<{ url: string; output: () => string }>;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: 'vercel' | 'local';
  create(opts: { timeoutMs: number; port: number }): Promise<Sandbox>;
  /** Stop a sandbox by the id the provider gave it (after a server restart). */
  stopById(id: string): Promise<void>;
}

export const SANDBOX_TIMEOUT_MS = 30 * 60_000;

const safeRel = (p: string) => {
  const n = normalize(p).replace(/^[/\\]+/, '');
  if (n.startsWith('..') || n.includes('\0')) throw new Error(`unsafe path ${p}`);
  return n;
};

async function waitForUrl(url: string, ms: number, alive: () => boolean, f: typeof fetch = fetch): Promise<void> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    if (!alive()) throw new Error('The dev server exited before it was ready.');
    try {
      const r = await f(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The app did not answer on its port within ${Math.round(ms / 1000)} s (${last}).`);
}

// ---- local ---------------------------------------------------------------------------------------------

const localLive = new Map<string, { dir: string; procs: ChildProcess[] }>();

/** Kill the process AND everything it started (npm run dev leaves the real server as a child). */
function killTree(p: ChildProcess) {
  try { if (p.pid) process.kill(-p.pid, 'SIGKILL'); else p.kill('SIGKILL'); }
  catch { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

export function localProvider(): SandboxProvider {
  if (process.env.NODE_ENV === 'production' && process.env.ENTOLI_ALLOW_LOCAL_SANDBOX !== '1') {
    throw new Error('The local sandbox runs developers\' code on this machine and is disabled in production. Use SANDBOX_PROVIDER=vercel.');
  }
  return {
    name: 'local',
    async create() {
      const dir = await mkdtemp(join(tmpdir(), 'entoli-sbx-'));
      const id = dir;
      const procs: ChildProcess[] = [];
      localLive.set(id, { dir, procs });
      const sb: Sandbox = {
        id,
        async writeFiles(files) {
          for (const f of files) {
            const p = join(dir, safeRel(f.path));
            await mkdir(dirname(p), { recursive: true });
            await writeFile(p, f.content);
          }
        },
        run(cmd, args, opts = {}) {
          return new Promise((resolve) => {
            let out = '';
            const child = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
            procs.push(child);
            const t = setTimeout(() => killTree(child), opts.timeoutMs ?? 300_000);
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });
            child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, output: out.slice(-8000) }); });
            child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, output: String(e) }); });
          });
        },
        async serve(cmd, args, port, opts = {}) {
          let out = '';
          let exited = false;
          const child = spawn(cmd, args, { cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
          procs.push(child);
          child.stdout.on('data', (d) => { out += d; });
          child.stderr.on('data', (d) => { out += d; });
          child.on('close', () => { exited = true; });
          const url = `http://127.0.0.1:${port}`;
          try { await waitForUrl(url, opts.readyMs ?? 120_000, () => !exited); }
          catch (e) { killTree(child); throw new Error(`${(e as Error).message}\n${out.slice(-1500)}`); }
          return { url, output: () => out.slice(-4000) };
        },
        async stop() { await stopLocal(id); },
      };
      return sb;
    },
    stopById: stopLocal,
  };
}

async function stopLocal(id: string) {
  const live = localLive.get(id);
  if (!live) return;
  for (const p of live.procs) killTree(p);
  localLive.delete(id);
  await rm(live.dir, { recursive: true, force: true });
}

// ---- Vercel Sandbox ---------------------------------------------------------------------------------------

/** Credentials: on Vercel the OIDC token is automatic; elsewhere set VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID. */
function credentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

export function vercelProvider(): SandboxProvider {
  return {
    name: 'vercel',
    async create({ timeoutMs, port }) {
      const { Sandbox: VSandbox } = await import('@vercel/sandbox');
      const sbx = await VSandbox.create({ runtime: 'node22', ports: [port], timeout: timeoutMs, ...credentials() });
      const sb: Sandbox = {
        id: sbx.name,
        async writeFiles(files) {
          await sbx.writeFiles(files.map((f) => ({ path: safeRel(f.path), content: typeof f.content === 'string' ? Buffer.from(f.content) : f.content })));
        },
        async run(cmd, args, opts = {}) {
          const r = await sbx.runCommand({ cmd, args, ...(opts.env ? { env: opts.env } : {}) });
          const [o, e] = await Promise.all([r.stdout(), r.stderr()]);
          return { code: r.exitCode, output: `${o}${e}`.slice(-8000) };
        },
        async serve(cmd, args, p, opts = {}) {
          const cmdRun = await sbx.runCommand({ cmd, args, detached: true, env: { PORT: String(p), HOST: '0.0.0.0', ...opts.env } });
          const url = sbx.domain(p);
          let exited = false;
          void cmdRun.wait().then(() => { exited = true; }, () => { exited = true; });
          try { await waitForUrl(url, opts.readyMs ?? 180_000, () => !exited); }
          catch (e) { throw new Error(`${(e as Error).message}\n${(await cmdRun.stderr().catch(() => '')).slice(-1500)}`); }
          return { url, output: () => '' };
        },
        async stop() { await sbx.stop(); },
      };
      return sb;
    },
    async stopById(id) {
      const { Sandbox: VSandbox } = await import('@vercel/sandbox');
      const sbx = await VSandbox.get({ name: id, ...credentials() });
      await sbx.stop();
    },
  };
}

export function sandboxProvider(): SandboxProvider {
  const which = process.env.SANDBOX_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'vercel' : 'local');
  if (which === 'vercel') return vercelProvider();
  if (which === 'local') return localProvider();
  throw new Error(`Unknown SANDBOX_PROVIDER "${which}" (vercel or local).`);
}
