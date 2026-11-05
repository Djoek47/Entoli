// Stripe webhook: the only place plans change. Signature verified on the raw body.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { applyEvent, getStripe, verifyEvent } from '@/lib/billing';

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: 'billing not configured' }, { status: 501 });
  const raw = await req.text();
  let event;
  try {
    event = verifyEvent(stripe, raw, req.headers.get('stripe-signature'));
  } catch (e) {
    return NextResponse.json({ error: `invalid signature: ${(e as Error).message}` }, { status: 400 });
  }
  const result = await applyEvent(await getDb(), stripe, event);
  return NextResponse.json({ received: true, result });
}
