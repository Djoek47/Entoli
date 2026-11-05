// Hourly (vercel.json): report metered usage deltas to Stripe. Vercel Cron sends CRON_SECRET as a bearer token.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { getStripe, reportUsage } from '@/lib/billing';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ skipped: 'billing not configured' });
  const reported = await reportUsage(await getDb(), stripe);
  return NextResponse.json({ reported });
}
