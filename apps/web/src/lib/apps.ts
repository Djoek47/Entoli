/**
 * Data access for the dashboard. Every function that reads or changes an app
 * takes the owner's user id and checks it: there is no "get app by id"
 * without an owner, so a guessed id leaks nothing.
 */
import { validateSkill, type Skill } from '@entoli/sdk/skill';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { apiKeys, apps, usage, users, type PlanId } from '@/db/schema';
import { generateKey, hashKey, keyPrefix, looksLikeKey } from './keys';
import { PLANS, period } from './plans';

export type GithubProfile = { githubId: string; login: string; name?: string | null; email?: string | null; avatarUrl?: string | null };

export async function upsertUser(db: DB, p: GithubProfile) {
  const [row] = await db
    .insert(users)
    .values({ githubId: p.githubId, login: p.login, name: p.name ?? null, email: p.email ?? null, avatarUrl: p.avatarUrl ?? null })
    .onConflictDoUpdate({ target: users.githubId, set: { login: p.login, name: p.name ?? null, email: p.email ?? null, avatarUrl: p.avatarUrl ?? null } })
    .returning();
  return row!;
}

export async function userByGithubId(db: DB, githubId: string) {
  const [u] = await db.select().from(users).where(eq(users.githubId, githubId));
  return u ?? null;
}

export function listApps(db: DB, ownerId: string) {
  return db.select().from(apps).where(eq(apps.ownerId, ownerId)).orderBy(desc(apps.createdAt));
}

export async function getApp(db: DB, ownerId: string, appId: string) {
  const [a] = await db.select().from(apps).where(and(eq(apps.id, appId), eq(apps.ownerId, ownerId)));
  return a ?? null;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function parseRepo(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\/github\.com\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  return REPO.test(s) ? s : null;
}

/** "owner/name", "owner/name#apps/web", or a github.com/owner/name/tree/main/apps/web URL → the repository and the folder inside it. */
export function parseRepoSpec(input: string): { repo: string; subdir: string | null } | null {
  const raw = input.trim();
  let subdir: string | null = null;
  let base = raw;
  const hash = raw.indexOf('#');
  if (hash >= 0) { base = raw.slice(0, hash); subdir = raw.slice(hash + 1); }
  else {
    const m = /^(?:https?:\/\/)?github\.com\/([^/]+\/[^/]+)\/tree\/[^/]+\/(.+)$/.exec(raw);
    if (m) { base = m[1]!; subdir = m[2]!; }
  }
  const repo = parseRepo(base);
  if (!repo) return null;
  if (subdir !== null) {
    const parts = subdir.split('/').filter((x) => x && x !== '.');
    if (parts.some((x) => x === '..' || /[\\\0]/.test(x))) return null;
    subdir = parts.join('/') || null;
  }
  return { repo, subdir };
}

export async function createApp(db: DB, ownerId: string, input: { name: string; repo?: string | null; subdir?: string | null }) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error('Give the app a name.');
  let repo: string | null = null;
  let subdir: string | null = null;
  if (input.repo && input.repo.trim()) {
    const spec = parseRepoSpec(input.repo);
    if (!spec) throw new Error('Repository must look like owner/name (or owner/name#folder) or a github.com URL.');
    repo = spec.repo;
    subdir = input.subdir ?? spec.subdir;
  }
  const existing = await listApps(db, ownerId);
  // The free plan covers one app; further apps start on the free plan too but
  // are flagged until upgraded (enforced at /api/intent).
  const [row] = await db.insert(apps).values({ ownerId, name, repo, subdir }).returning();
  return { app: row!, overFreeLimit: existing.filter((a) => a.plan === 'developer').length >= (PLANS.developer.maxApps ?? 1) };
}

export async function deleteApp(db: DB, ownerId: string, appId: string) {
  await db.delete(apps).where(and(eq(apps.id, appId), eq(apps.ownerId, ownerId)));
}

export async function setRepo(db: DB, ownerId: string, appId: string, repo: string | null, installationId?: string | null, subdir?: string | null) {
  const set: Partial<typeof apps.$inferInsert> = { repo };
  if (subdir !== undefined) set.subdir = subdir;
  if (installationId !== undefined) set.installationId = installationId;
  await db.update(apps).set(set).where(and(eq(apps.id, appId), eq(apps.ownerId, ownerId)));
}

/**
 * The tester opens this URL in a server-side browser, so it must not point
 * inside our network. Production: https only, no IP literals for private,
 * loopback or link-local ranges, no localhost.
 */
export function checkPreviewUrl(raw: string, production = process.env.NODE_ENV === 'production'): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Not a URL.'; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !production)) return production ? 'Preview URL must use https.' : 'Preview URL must start with http:// or https://';
  if (!production) return null;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return 'Preview URL must be publicly reachable.';
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^(::1?|f[cd]|fe80)/.test(h) || /^\d+$/.test(h)) return 'Preview URL must be publicly reachable.';
  return null;
}

export async function setPreviewUrl(db: DB, ownerId: string, appId: string, url: string | null) {
  const problem = url ? checkPreviewUrl(url) : null;
  if (problem) throw new Error(problem);
  await db.update(apps).set({ previewUrl: url }).where(and(eq(apps.id, appId), eq(apps.ownerId, ownerId)));
}

export type SaveSkillResult = { ok: true; warnings: string[] } | { ok: false; errors: string[] };

/** Saves only a valid skill. Layer 2 needs a plan that includes it to be published. */
export async function saveSkill(db: DB, ownerId: string, appId: string, input: unknown, status: 'draft' | 'published' = 'draft'): Promise<SaveSkillResult> {
  const app = await getApp(db, ownerId, appId);
  if (!app) return { ok: false, errors: ['App not found.'] };
  const r = validateSkill(input);
  if (!r.ok) return { ok: false, errors: r.errors };
  const usesAi = r.skill.layer === 'L2' ? r.skill.acts.some((a) => a.layer !== 'L1' && a.layer !== 'off') : r.skill.acts.some((a) => a.layer === 'L2');
  if (status === 'published' && usesAi && !PLANS[app.plan].ai) {
    return { ok: false, errors: [`Layer 2 (Entoli AI answers) needs the L2 plan. You are on ${PLANS[app.plan].name}: set those acts to "L1" or upgrade.`] };
  }
  await db.update(apps).set({ skill: r.skill, skillStatus: status }).where(eq(apps.id, appId));
  return { ok: true, warnings: r.warnings };
}

export function skillOf(app: { skill: unknown }): Skill | null {
  const r = validateSkill(app.skill);
  return r.ok ? r.skill : null;
}

// ---- keys -----------------------------------------------------------------

export async function createKey(db: DB, ownerId: string, appId: string, label = 'default') {
  const app = await getApp(db, ownerId, appId);
  if (!app) throw new Error('App not found.');
  const key = generateKey('live');
  const [row] = await db.insert(apiKeys).values({ appId, label: label.slice(0, 40) || 'default', prefix: keyPrefix(key), hash: hashKey(key) }).returning();
  // The only time the full key exists outside the developer's hands.
  return { key, row: row! };
}

export async function listKeys(db: DB, ownerId: string, appId: string) {
  const app = await getApp(db, ownerId, appId);
  if (!app) return [];
  return db.select({ id: apiKeys.id, label: apiKeys.label, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys).where(eq(apiKeys.appId, appId)).orderBy(desc(apiKeys.createdAt));
}

export async function revokeKey(db: DB, ownerId: string, appId: string, keyId: string) {
  const app = await getApp(db, ownerId, appId);
  if (!app) return;
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.appId, appId)));
}

/** Resolve a presented key to its app. Revoked or malformed keys resolve to null. */
export async function appByKey(db: DB, key: string) {
  if (!looksLikeKey(key)) return null;
  const [row] = await db.select({ app: apps, keyId: apiKeys.id }).from(apiKeys)
    .innerJoin(apps, eq(apps.id, apiKeys.appId))
    .where(and(eq(apiKeys.hash, hashKey(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return row.app;
}

// ---- usage ----------------------------------------------------------------

export type UsageRow = typeof usage.$inferSelect;

export async function getUsage(db: DB, appId: string, p = period()): Promise<UsageRow> {
  const [u] = await db.select().from(usage).where(and(eq(usage.appId, appId), eq(usage.period, p)));
  return u ?? { appId, period: p, textIntents: 0, voiceTurns: 0, modelCalls: 0, toolTurns: 0, liveSeconds: 0, tokensIn: 0, tokensOut: 0, costMicros: 0, reportedVoice: 0, reportedOverage: 0 };
}

export type Meter = { text?: number; voice?: number; tool?: number; live?: number; modelCalls?: number; tokensIn?: number; tokensOut?: number; costMicros?: number };

/** Atomic increment (single upsert statement). */
export async function meter(db: DB, appId: string, m: Meter, p = period()): Promise<UsageRow> {
  const v = { text: m.text ?? 0, voice: m.voice ?? 0, tool: m.tool ?? 0, live: m.live ?? 0, calls: m.modelCalls ?? 0, ti: m.tokensIn ?? 0, to: m.tokensOut ?? 0, cost: m.costMicros ?? 0 };
  const [row] = await db.insert(usage)
    .values({ appId, period: p, textIntents: v.text, voiceTurns: v.voice, toolTurns: v.tool, liveSeconds: v.live, modelCalls: v.calls, tokensIn: v.ti, tokensOut: v.to, costMicros: v.cost })
    .onConflictDoUpdate({
      target: [usage.appId, usage.period],
      set: {
        textIntents: sql`${usage.textIntents} + ${v.text}`,
        voiceTurns: sql`${usage.voiceTurns} + ${v.voice}`,
        toolTurns: sql`${usage.toolTurns} + ${v.tool}`,
        liveSeconds: sql`${usage.liveSeconds} + ${v.live}`,
        modelCalls: sql`${usage.modelCalls} + ${v.calls}`,
        tokensIn: sql`${usage.tokensIn} + ${v.ti}`,
        tokensOut: sql`${usage.tokensOut} + ${v.to}`,
        costMicros: sql`${usage.costMicros} + ${v.cost}`,
      },
    })
    .returning();
  return row!;
}

export async function setPlan(db: DB, appId: string, plan: PlanId, sub?: { id: string | null; status: string | null }) {
  const set: Partial<typeof apps.$inferInsert> = { plan };
  if (sub) { set.stripeSubscriptionId = sub.id; set.subscriptionStatus = sub.status; }
  await db.update(apps).set(set).where(eq(apps.id, appId));
}
