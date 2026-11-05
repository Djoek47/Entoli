// One-time (idempotent) Stripe setup: meters, products and prices with lookup keys.
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
// Run it once in test mode and once in live mode. Safe to re-run.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }
const stripe = new Stripe(key);

async function meter(event_name, display_name) {
  const all = await stripe.billing.meters.list({ limit: 100 });
  const found = all.data.find((m) => m.event_name === event_name && m.status === 'active');
  if (found) return found.id;
  const m = await stripe.billing.meters.create({ display_name, event_name, default_aggregation: { formula: 'sum' } });
  console.log(`meter ${event_name}: created ${m.id}`);
  return m.id;
}

async function product(id, name, description) {
  try { return (await stripe.products.retrieve(id)).id; }
  catch { return (await stripe.products.create({ id, name, description })).id; }
}

async function price(lookup_key, params) {
  const existing = await stripe.prices.list({ lookup_keys: [lookup_key], limit: 1 });
  if (existing.data[0]) { console.log(`price ${lookup_key}: exists ${existing.data[0].id}`); return; }
  const p = await stripe.prices.create({ currency: 'usd', lookup_key, ...params });
  console.log(`price ${lookup_key}: created ${p.id}`);
}

const voiceMeter = await meter('entoli_voice_turns', 'Entoli voice turns');
const overageMeter = await meter('entoli_text_overage', 'Entoli text intents over plan');

const l1 = await product('entoli_l1', 'Entoli L1 Control', '25,000 text intents a month per app; voice metered.');
const l2 = await product('entoli_l2', 'Entoli L2 Integrated', '100,000 text intents a month per app; settings by voice; voice metered.');
const voice = await product('entoli_voice', 'Entoli voice turns', 'Per spoken turn.');
const overage = await product('entoli_overage', 'Entoli extra text intents', '$2 per 1,000 beyond the plan.');
const managed = await product('entoli_managed', 'Entoli managed setup', 'We scan and integrate. One time.');

await price('entoli_l1_monthly', { product: l1, unit_amount: 4900, recurring: { interval: 'month' } });
await price('entoli_l2_monthly', { product: l2, unit_amount: 29900, recurring: { interval: 'month' } });
await price('entoli_voice_l1', { product: voice, unit_amount: 2, recurring: { interval: 'month', usage_type: 'metered', meter: voiceMeter }, nickname: 'Voice (L1) $0.02/turn' });
await price('entoli_voice_l2', { product: voice, unit_amount_decimal: Stripe.Decimal.from('1.5'), recurring: { interval: 'month', usage_type: 'metered', meter: voiceMeter }, nickname: 'Voice (L2) $0.015/turn' });
await price('entoli_text_overage', { product: overage, unit_amount_decimal: Stripe.Decimal.from('0.2'), recurring: { interval: 'month', usage_type: 'metered', meter: overageMeter }, nickname: '$2 per 1,000 intents' });
await price('entoli_managed_setup', { product: managed, unit_amount: 250000 });

console.log('\nDone. Next: add a webhook endpoint https://<your-domain>/api/stripe/webhook with events');
console.log('  checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted');
console.log('and put its signing secret in STRIPE_WEBHOOK_SECRET. Enable the customer portal in the Stripe dashboard.');
