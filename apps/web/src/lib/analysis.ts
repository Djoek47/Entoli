/**
 * The analysis job: fetch the repository read-only, run @entoli/analyzer,
 * save the result as a DRAFT skill for the developer to edit, and log what
 * the model pass cost.
 */
import { analyze, hasAnthropicKey } from '@entoli/analyzer';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { DB } from '@/db';
import { analyses, apps } from '@/db/schema';
import { saveSkill } from './apps';
import { fetchRepo, type Fetched } from './repo-fetch';

export const ANALYSIS_LIMITS = {
  maxInputTokens: Number(process.env.ANALYSIS_MAX_INPUT_TOKENS ?? 60_000),
  maxOutputTokens: Number(process.env.ANALYSIS_MAX_OUTPUT_TOKENS ?? 32_000),
  maxFiles: Number(process.env.ANALYSIS_MAX_FILES ?? 3_000),
};

export type AppRow = typeof apps.$inferSelect;
export type Source = (app: AppRow) => Promise<Fetched>;

const defaultSource: Source = (app) => {
  if (!app.repo) throw new Error('Connect a repository first.');
  return fetchRepo(app.repo, { installationId: app.installationId });
};

/** Creates the job row. Refuses a second job for the same app while one is running. */
export async function queueAnalysis(db: DB, app: AppRow): Promise<{ id: string } | { error: string }> {
  if (!app.repo) return { error: 'Connect a repository first.' };
  const recent = new Date(Date.now() - 10 * 60_000);
  const [busy] = await db.select({ id: analyses.id }).from(analyses)
    .where(and(eq(analyses.appId, app.id), inArray(analyses.status, ['queued', 'running']), gt(analyses.createdAt, recent)));
  if (busy) return { error: 'An analysis is already running for this app.' };
  const [row] = await db.insert(analyses).values({ appId: app.id, status: 'queued', log: [] }).returning({ id: analyses.id });
  return { id: row!.id };
}

export async function runAnalysis(db: DB, app: AppRow, analysisId: string, source: Source = defaultSource): Promise<void> {
  const log: string[] = [];
  const flush = (patch: Partial<typeof analyses.$inferInsert> = {}) => db.update(analyses).set({ log: [...log], ...patch }).where(eq(analyses.id, analysisId));
  let fetched: Fetched | null = null;
  try {
    await flush({ status: 'running' });
    log.push(`Fetching ${app.repo} (read-only)…`);
    await flush();
    fetched = await source(app);
    log.push(`Downloaded ${(fetched.bytes / 1e6).toFixed(1)} MB.`);
    const r = await analyze(fetched.dir, {
      maxFiles: ANALYSIS_LIMITS.maxFiles,
      maxInputTokens: ANALYSIS_LIMITS.maxInputTokens,
      maxOutputTokens: ANALYSIS_LIMITS.maxOutputTokens,
      ai: hasAnthropicKey(),
      log: (l) => { log.push(l); void flush(); },
    });
    // The repo name is a better app name than the folder we extracted into.
    r.skill.app = { ...r.skill.app, name: app.name, repo: app.repo ?? undefined };
    const saved = await saveSkill(db, app.ownerId, app.id, r.skill, 'draft');
    if (!saved.ok) throw new Error(`Draft did not validate: ${saved.errors.slice(0, 3).join('; ')}`);
    log.push('Saved as a draft. Review the map, the acts and their contract, then publish.');
    console.info(`[analysis] app=${app.id} files=${r.scan.files} model=${r.usedModel ? r.model : 'none'} in=${r.usage.tokensIn} out=${r.usage.tokensOut} cost_usd=${(r.costMicros / 1e6).toFixed(4)}`);
    await flush({
      status: 'done', filesScanned: r.scan.files, usedModel: r.usedModel,
      tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut, costMicros: r.costMicros, finishedAt: new Date(),
    });
  } catch (e) {
    log.push(`Failed: ${(e as Error).message}`);
    await flush({ status: 'failed', error: (e as Error).message, finishedAt: new Date() });
  } finally {
    await fetched?.cleanup().catch(() => {});
  }
}

export function listAnalyses(db: DB, appId: string, limit = 5) {
  return db.select().from(analyses).where(eq(analyses.appId, appId)).orderBy(desc(analyses.createdAt)).limit(limit);
}
