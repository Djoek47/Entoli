// POST /api/test-runs — CI uploads an `entoli-test --json` report with the app key.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { appByKey } from '@/lib/apps';
import { hit } from '@/lib/ratelimit';
import { parseReport, storeReport } from '@/lib/test-runs';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  const db = await getDb();
  const app = auth.startsWith('Bearer ') ? await appByKey(db, auth.slice(7).trim()) : null;
  if (!app) return NextResponse.json({ error: 'invalid or revoked app key' }, { status: 401 });
  if (!(await hit(db, `test-runs:${app.id}`, 30, 3_600_000)).ok) return NextResponse.json({ error: 'rate limit' }, { status: 429 });
  const report = parseReport(await req.json().catch(() => null));
  if (!report) return NextResponse.json({ error: 'not an entoli-test report' }, { status: 400 });
  const row = await storeReport(db, app.id, report);
  return NextResponse.json({ id: row.id, coverage: row.coverage }, { status: 201 });
}
