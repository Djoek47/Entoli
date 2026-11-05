// POST /api/intent — called from the developer's front end with the public app key.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { handleIntent } from '@/lib/intent';

export const maxDuration = 60;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
  'access-control-expose-headers': 'x-entoli-text-intents, x-entoli-voice-turns, x-entoli-warning, retry-after',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body required' }, { status: 400, headers: CORS });
  const r = await handleIntent(await getDb(), { key, origin: req.headers.get('origin'), body });
  return NextResponse.json(r.body, { status: r.status, headers: { ...CORS, ...(r.headers ?? {}) } });
}
