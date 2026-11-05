/**
 * GitHub App: per-repository access. Read-only (contents: read, metadata:
 * read) is what the analyzer needs. Write access (contents + pull requests)
 * is requested only by the guided integration (M7), which opens one pull
 * request; a developer who never uses it never grants it.
 */
import { createSign } from 'node:crypto';

export const githubAppConfigured = () => !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_SLUG);

export function installUrl(state: string): string | null {
  const slug = process.env.GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}` : null;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** RS256 JWT for the App itself (10 minutes). */
export function appJwt(appId = process.env.GITHUB_APP_ID, pem = process.env.GITHUB_APP_PRIVATE_KEY, now = Math.floor(Date.now() / 1000)): string {
  if (!appId || !pem) throw new Error('GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY).');
  const key = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

type Fetch = typeof fetch;

async function gh<T>(path: string, token: string, init: RequestInit = {}, f: Fetch = fetch): Promise<T> {
  const res = await f(`https://api.github.com${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'entoli', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export type Installation = { id: number; account: { login: string; type: string } | null; permissions: Record<string, string>; repository_selection: 'all' | 'selected' };

export function getInstallation(id: string, f?: Fetch) {
  return gh<Installation>(`/app/installations/${encodeURIComponent(id)}`, appJwt(), {}, f);
}

/** A short-lived installation token, optionally narrowed to one repository and read-only. */
export async function installationToken(id: string, opts: { repo?: string; write?: boolean } = {}, f?: Fetch): Promise<string> {
  const body: Record<string, unknown> = { permissions: opts.write ? { contents: 'write', pull_requests: 'write', metadata: 'read' } : { contents: 'read', metadata: 'read' } };
  if (opts.repo) body.repositories = [opts.repo.split('/')[1]];
  const r = await gh<{ token: string }>(`/app/installations/${encodeURIComponent(id)}/access_tokens`, appJwt(), { method: 'POST', body: JSON.stringify(body) }, f);
  return r.token;
}

export async function installationRepos(id: string, f?: Fetch): Promise<string[]> {
  const token = await installationToken(id, {}, f);
  const r = await gh<{ repositories: { full_name: string }[] }>(`/installation/repositories?per_page=100`, token, {}, f);
  return r.repositories.map((x) => x.full_name);
}

export { gh };
