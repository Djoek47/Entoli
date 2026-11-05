// POST /api/studio/intent — the AI behind the dashboard's own Entoli bar (the voice tool).
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { requireUser } from '@/lib/session';
import { handleStudioIntent } from '@/lib/studio';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await requireUser();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  const r = await handleStudioIntent(await getDb(), user.id, body);
  return NextResponse.json(r.body, { status: r.status });
}
