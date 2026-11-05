// POST /api/analyze { appId } → { id }   ·   GET /api/analyze?id=… → job status
// Session-authenticated (the developer's dashboard), owner-checked.
import { and, eq } from 'drizzle-orm';
import { after, NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { analyses, apps } from '@/db/schema';
import { getApp } from '@/lib/apps';
import { queueAnalysis, runAnalysis } from '@/lib/analysis';
import { hit } from '@/lib/ratelimit';
import { requireUser } from '@/lib/session';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as { appId?: string };
  const db = await getDb();
  const app = body.appId ? await getApp(db, user.id, body.appId) : null;
  if (!app) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  if (!(await hit(db, `analyze:${user.id}`, 10, 3_600_000)).ok) return NextResponse.json({ error: 'rate limit' }, { status: 429 });
  const q = await queueAnalysis(db, app);
  if ('error' in q) return NextResponse.json(q, { status: 409 });
  after(() => runAnalysis(db, app, q.id));
  return NextResponse.json({ id: q.id }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const db = await getDb();
  const [row] = await db.select({ a: analyses }).from(analyses).innerJoin(apps, eq(apps.id, analyses.appId))
    .where(and(eq(analyses.id, id), eq(apps.ownerId, user.id)));
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const a = row.a;
  return NextResponse.json({ id: a.id, status: a.status, log: a.log, filesScanned: a.filesScanned, usedModel: a.usedModel, tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsd: a.costMicros / 1e6, error: a.error });
}
