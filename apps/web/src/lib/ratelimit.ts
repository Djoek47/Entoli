/** Fixed-window rate limit in Postgres (one upsert per call), so it holds across serverless instances. */
import { lt, sql } from 'drizzle-orm';
import type { DB } from '@/db';
import { rateLimits } from '@/db/schema';

export async function hit(db: DB, key: string, limit: number, windowMs = 60_000, now = Date.now()): Promise<{ ok: boolean; count: number; resetAt: Date }> {
  const start = now - (now % windowMs);
  const bucket = `${key}:${start}`;
  const resetAt = new Date(start + windowMs);
  const [row] = await db.insert(rateLimits).values({ bucket, count: 1, resetAt })
    .onConflictDoUpdate({ target: rateLimits.bucket, set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  // Occasionally sweep old windows.
  if (Math.random() < 0.01) await db.delete(rateLimits).where(lt(rateLimits.resetAt, new Date(now - 3_600_000)));
  const count = row?.count ?? 1;
  return { ok: count <= limit, count, resetAt };
}
