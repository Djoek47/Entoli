// POST /api/voice/session { appId } — a short-lived realtime key for the dashboard's always-on voice (L2 plan).
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { requireUser } from '@/lib/session';
import { mintSession } from '@/lib/voice';

export async function POST(req: NextRequest) {
  const user = await requireUser();
  const body = await req.json().catch(() => ({}));
  const r = await mintSession(await getDb(), user.id, body);
  return NextResponse.json(r.body, { status: r.status });
}
