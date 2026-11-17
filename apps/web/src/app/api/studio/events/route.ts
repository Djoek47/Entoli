// GET /api/studio/events?appId=…&since=ISO — what the developer's coding agent did since then (for the live conversation).
import { and, eq, gt } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { agentEvents } from '@/db/schema';
import { announce } from '@/lib/agent-announce';
import { getApp } from '@/lib/apps';
import { requireUser } from '@/lib/session';

export async function GET(req: NextRequest) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, req.nextUrl.searchParams.get('appId') ?? '');
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const since = new Date(req.nextUrl.searchParams.get('since') ?? 0);
  if (Number.isNaN(since.getTime())) return NextResponse.json({ error: 'bad since' }, { status: 400 });
  const events = await db.select().from(agentEvents).where(and(eq(agentEvents.appId, app.id), gt(agentEvents.createdAt, since))).limit(50);
  return NextResponse.json({ announcement: announce(events), count: events.length, now: new Date().toISOString() });
}
