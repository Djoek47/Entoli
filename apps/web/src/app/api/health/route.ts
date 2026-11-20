// GET /api/health — is the deployment up? No data, no secrets: safe for uptime monitors and the smoke test.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const GET = () => NextResponse.json({ ok: true });
