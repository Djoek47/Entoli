// GET /api/apps/:id/project — download the project's files as a zip.
import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { getApp } from '@/lib/apps';
import { exportZip, isProject } from '@/lib/project';
import { requireUser } from '@/lib/session';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, (await params).id);
  if (!app || !isProject(app)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const zip = await exportZip(db, app.id);
    const name = app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    return new NextResponse(Buffer.from(zip), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"` } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
