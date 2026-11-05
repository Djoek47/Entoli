/** Map-walk reports: run from the dashboard, or uploaded from CI with the app key. */
import type { Report } from '@entoli/tester';
import { desc, eq } from 'drizzle-orm';
import type { DB } from '@/db';
import { testRuns } from '@/db/schema';
import { skillOf } from './apps';

export type StoredReport = Pick<Report, 'url' | 'coverage' | 'checked' | 'verified' | 'broken' | 'unchecked' | 'ms' | 'startedAt'> & { source: 'dashboard' | 'ci' };

const MAX_REPORT_BYTES = 300_000;

/** Validates an uploaded report enough to store and show it. */
export function parseReport(raw: unknown): StoredReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 500).filter((x): x is { id: string; title: string; kind: string; status: string; reason?: string } => !!x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string').map((x) => ({ id: String(x.id).slice(0, 200), title: x.title.slice(0, 200), kind: String(x.kind).slice(0, 20), status: x.status === 'ok' || x.status === 'broken' ? x.status : 'unchecked' as const, ...(x.reason ? { reason: String(x.reason).slice(0, 300) } : {}) })) : null);
  const coverage = num(r.coverage, 100);
  const checked = num(r.checked);
  const verified = num(r.verified);
  const broken = list(r.broken);
  const unchecked = list(r.unchecked);
  if (typeof r.url !== 'string' || coverage === null || checked === null || verified === null || !broken || !unchecked || verified > checked) return null;
  return { url: r.url.slice(0, 500), coverage: Math.round(coverage), checked, verified, broken: broken as Report['broken'], unchecked: unchecked as Report['unchecked'], ms: num(r.ms) ?? 0, startedAt: typeof r.startedAt === 'string' ? r.startedAt.slice(0, 40) : new Date().toISOString(), source: 'ci' };
}

export async function storeReport(db: DB, appId: string, report: StoredReport) {
  if (JSON.stringify(report).length > MAX_REPORT_BYTES) throw new Error('report too large');
  const [row] = await db.insert(testRuns).values({ appId, url: report.url, coverage: report.coverage, report }).returning();
  return row!;
}

export function listRuns(db: DB, appId: string, limit = 5) {
  return db.select().from(testRuns).where(eq(testRuns.appId, appId)).orderBy(desc(testRuns.createdAt)).limit(limit);
}

/** Runs the walk with a browser on this server (dev), or a remote one (BROWSER_WS_ENDPOINT). */
export async function runFromDashboard(db: DB, app: { id: string; skill: unknown; previewUrl: string | null }) {
  const skill = skillOf(app);
  if (!skill) throw new Error('No valid skill yet.');
  if (!app.previewUrl) throw new Error('Set a preview URL first.');
  if (process.env.NODE_ENV === 'production' && !process.env.BROWSER_WS_ENDPOINT) {
    throw new Error('No browser on this deployment. Set BROWSER_WS_ENDPOINT, or run `entoli-test` in CI with --upload.');
  }
  const { testApp } = await import('@entoli/tester');
  const r = await testApp(skill, app.previewUrl);
  return storeReport(db, app.id, { url: r.url, coverage: r.coverage, checked: r.checked, verified: r.verified, broken: r.broken, unchecked: r.unchecked, ms: r.ms, startedAt: r.startedAt, source: 'dashboard' });
}
