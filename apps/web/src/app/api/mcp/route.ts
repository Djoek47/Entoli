// The Entoli MCP server (Streamable HTTP, stateless, JSON responses).
// Add it to Claude Code, Cursor or any MCP client with a token from the dashboard (Keys tab).
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { handleMcp } from '@/lib/mcp';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const r = await handleMcp(await getDb(), { authorization: req.headers.get('authorization'), body });
  if (r.body === undefined) return new NextResponse(null, { status: r.status, headers: r.headers });
  return NextResponse.json(r.body, { status: r.status, headers: r.headers });
}

// No server-initiated streams: the spec lets a server answer GET with 405.
export function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}
export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}
