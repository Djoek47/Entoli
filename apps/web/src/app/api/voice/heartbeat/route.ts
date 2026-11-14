// POST /api/voice/heartbeat { appId, seconds } — meters live-voice time and says when to stop.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { requireUser } from '@/lib/session';
import { heartbeat } from '@/lib/voice';

export async function POST(req: NextRequest) {
  const user = await requireUser();
  const body = await req.json().catch(() => ({}));
  const r = await heartbeat(await getDb(), user.id, body);
  return NextResponse.json(r.body, { status: r.status });
}
