// GET /api/apps/:id/agent-skill?format=claude|cursor|agents — download the skill for a coding agent.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { agentSkillFile, type AgentFormat } from '@/lib/agent-skill';
import { getApp, skillOf } from '@/lib/apps';
import { latestSources } from '@/lib/integration';
import { PLANS } from '@/lib/plans';
import { requireUser } from '@/lib/session';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, (await params).id);
  if (!app) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (PLANS[app.plan].priceUsd === 0) return NextResponse.json({ error: 'Exporting the skill is part of the L1 and L2 plans.' }, { status: 402 });
  const skill = skillOf(app);
  if (!skill) return NextResponse.json({ error: 'No valid skill yet.' }, { status: 409 });
  const format = (['claude', 'cursor', 'agents'] as const).includes(req.nextUrl.searchParams.get('format') as AgentFormat) ? (req.nextUrl.searchParams.get('format') as AgentFormat) : 'claude';
  const f = agentSkillFile(skill, await latestSources(db, app.id), format);
  return new NextResponse(f.content, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${f.filename}"` } });
}
