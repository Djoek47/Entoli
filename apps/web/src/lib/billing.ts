/**
 * Billing with Stripe.
 *
 *   plans          Checkout (subscription) per app: the plan's flat price plus
 *                  two metered prices (voice turns, text overage)
 *   usage          Billing Meters. An hourly job reports the deltas since the
 *                  last report; event identifiers make retries safe
 *   plan changes   only from verified webhooks (never from the redirect)
 *   managed setup  one-time Checkout that opens a request in the dashboard
 *
 * Prices are found by lookup key (scripts/stripe-setup.mjs creates them), so
 * no price ids live in env vars. One Stripe customer per app.
 */
import { and, eq, inArray, ne, isNotNull } from 'drizzle-orm';
import Stripe from 'stripe';
import type { DB } from '@/db';
import { apps, managedRequests, users, type PlanId } from '@/db/schema';
import { getUsage, setPlan } from './apps';
import { PLANS, period } from './plans';

export const LOOKUP = {
  l1: 'entoli_l1_monthly',
  l2: 'entoli_l2_monthly',
  voiceL2: 'entoli_voice_l2',
  overage: 'entoli_text_overage',
  managed: 'entoli_managed_setup',
} as const;

export const METERS = { voice: 'entoli_voice_turns', overage: 'entoli_text_overage' } as const;

export type StripeLike = Pick<Stripe, 'prices' | 'customers' | 'checkout' | 'billingPortal' | 'subscriptions' | 'billing' | 'webhooks'>;

let client: Stripe | null = null;
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!client) client = new Stripe(key);
  return client;
}
export const billingConfigured = () => !!process.env.STRIPE_SECRET_KEY;

let priceCache: { at: number; byKey: Map<string, string> } | null = null;
export async function priceIds(stripe: StripeLike): Promise<Map<string, string>> {
  if (priceCache && Date.now() - priceCache.at < 10 * 60_000) return priceCache.byKey;
  const res = await stripe.prices.list({ lookup_keys: Object.values(LOOKUP), active: true, limit: 20 });
  const byKey = new Map(res.data.filter((p) => p.lookup_key).map((p) => [p.lookup_key!, p.id]));
  for (const k of Object.values(LOOKUP)) if (!byKey.has(k)) throw new Error(`Stripe price "${k}" is missing. Run scripts/stripe-setup.mjs.`);
  priceCache = { at: Date.now(), byKey };
  return byKey;
}
export function resetPriceCache() { priceCache = null; }

type AppRow = typeof apps.$inferSelect;
type UserRow = typeof users.$inferSelect;

export async function ensureCustomer(db: DB, stripe: StripeLike, app: AppRow, user: UserRow): Promise<string> {
  if (app.stripeCustomerId) return app.stripeCustomerId;
  const c = await stripe.customers.create(
    { name: `${app.name} (${user.login})`, ...(user.email ? { email: user.email } : {}), metadata: { appId: app.id, userId: user.id } },
    { idempotencyKey: `customer-${app.id}` },
  );
  await db.update(apps).set({ stripeCustomerId: c.id }).where(eq(apps.id, app.id));
  return c.id;
}

export async function createCheckout(db: DB, stripe: StripeLike, input: { app: AppRow; user: UserRow; plan: 'l1' | 'l2'; origin: string }): Promise<string> {
  const ids = await priceIds(stripe);
  const customer = await ensureCustomer(db, stripe, input.app, input.user);
  // L1 is the skill: one flat price. L2 adds the metered AI (voice turns, intents over the plan).
  const line_items = input.plan === 'l1'
    ? [{ price: ids.get(LOOKUP.l1)!, quantity: 1 }]
    : [{ price: ids.get(LOOKUP.l2)!, quantity: 1 }, { price: ids.get(LOOKUP.voiceL2)! }, { price: ids.get(LOOKUP.overage)! }];
  const back = `${input.origin}/dashboard/apps/${input.app.id}/billing`;
  const s = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: input.app.id,
    line_items,
    subscription_data: { metadata: { appId: input.app.id, plan: input.plan } },
    metadata: { appId: input.app.id, plan: input.plan, kind: 'plan' },
    success_url: `${back}?checkout=success`,
    cancel_url: `${back}?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  if (!s.url) throw new Error('Stripe did not return a Checkout URL.');
  return s.url;
}

export async function createPortal(stripe: StripeLike, app: AppRow, origin: string): Promise<string> {
  if (!app.stripeCustomerId) throw new Error('This app has no billing account yet.');
  const s = await stripe.billingPortal.sessions.create({ customer: app.stripeCustomerId, return_url: `${origin}/dashboard/apps/${app.id}/billing` });
  return s.url;
}

export async function createManagedCheckout(db: DB, stripe: StripeLike, input: { user: UserRow; appId: string | null; notes: string; origin: string }): Promise<string> {
  const ids = await priceIds(stripe);
  const [req] = await db.insert(managedRequests).values({ userId: input.user.id, appId: input.appId, notes: input.notes.slice(0, 2000), status: 'pending_payment' }).returning();
  const back = input.appId ? `${input.origin}/dashboard/apps/${input.appId}/billing` : `${input.origin}/dashboard`;
  const s = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: ids.get(LOOKUP.managed)!, quantity: 1 }],
    ...(input.user.email ? { customer_email: input.user.email } : {}),
    client_reference_id: req!.id,
    metadata: { kind: 'managed', requestId: req!.id, userId: input.user.id },
    success_url: `${back}?managed=success`,
    cancel_url: `${back}?managed=cancelled`,
  });
  await db.update(managedRequests).set({ stripeSessionId: s.id }).where(eq(managedRequests.id, req!.id));
  if (!s.url) throw new Error('Stripe did not return a Checkout URL.');
  return s.url;
}

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

function planFromSubscription(sub: Stripe.Subscription): PlanId {
  const keys = sub.items.data.map((i) => i.price.lookup_key);
  if (keys.includes(LOOKUP.l2)) return 'l2';
  if (keys.includes(LOOKUP.l1)) return 'l1';
  const meta = sub.metadata?.plan;
  return meta === 'l1' || meta === 'l2' ? meta : 'developer';
}

/** Applies a verified Stripe event. Every branch is idempotent. */
export async function applyEvent(db: DB, stripe: StripeLike, event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      if (s.metadata?.kind === 'managed' && s.metadata.requestId) {
        if (s.payment_status === 'paid') await db.update(managedRequests).set({ status: 'paid' }).where(and(eq(managedRequests.id, s.metadata.requestId), eq(managedRequests.status, 'pending_payment')));
        return 'managed paid';
      }
      if (s.mode === 'subscription' && s.subscription && s.metadata?.appId) {
        const sub = await stripe.subscriptions.retrieve(typeof s.subscription === 'string' ? s.subscription : s.subscription.id);
        await syncSubscription(db, s.metadata.appId, sub);
        return `plan ${planFromSubscription(sub)}`;
      }
      return 'ignored';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const appId = sub.metadata?.appId ?? (await appIdForCustomer(db, typeof sub.customer === 'string' ? sub.customer : sub.customer.id));
      if (!appId) return 'unknown app';
      await syncSubscription(db, appId, sub, event.type === 'customer.subscription.deleted');
      return `subscription ${sub.status}`;
    }
    default:
      return 'ignored';
  }
}

async function appIdForCustomer(db: DB, customer: string): Promise<string | null> {
  const [a] = await db.select({ id: apps.id }).from(apps).where(eq(apps.stripeCustomerId, customer));
  return a?.id ?? null;
}

async function syncSubscription(db: DB, appId: string, sub: Stripe.Subscription, deleted = false) {
  const paid = !deleted && PAID_STATUSES.has(sub.status);
  await setPlan(db, appId, paid ? planFromSubscription(sub) : 'developer', { id: deleted ? null : sub.id, status: deleted ? 'canceled' : sub.status });
}

export function verifyEvent(stripe: StripeLike, raw: string, signature: string | null, secret = process.env.STRIPE_WEBHOOK_SECRET): Stripe.Event {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  if (!signature) throw new Error('missing stripe-signature');
  return stripe.webhooks.constructEvent(raw, signature, secret);
}

/**
 * Reports voice turns and text overage since the last report, for every app
 * on a paid plan. Safe to run as often as you like.
 */
export async function reportUsage(db: DB, stripe: StripeLike, now = new Date()): Promise<{ app: string; voice: number; overage: number }[]> {
  const p = period(now);
  // Only plans with metered AI have anything to report.
  const metered = (Object.keys(PLANS) as PlanId[]).filter((p) => PLANS[p].ai);
  const rows = await db.select().from(apps).where(and(inArray(apps.plan, metered), ne(apps.plan, 'developer'), isNotNull(apps.stripeCustomerId), inArray(apps.subscriptionStatus, [...PAID_STATUSES])));
  const out: { app: string; voice: number; overage: number }[] = [];
  const { usage } = await import('@/db/schema');
  for (const app of rows) {
    const u = await getUsage(db, app.id, p);
    const plan = PLANS[app.plan];
    const overageNow = Math.max(0, u.textIntents - plan.includedText);
    const voiceDelta = u.voiceTurns - u.reportedVoice;
    const overageDelta = overageNow - u.reportedOverage;
    const ts = Math.floor(now.getTime() / 1000);
    if (voiceDelta > 0) {
      await stripe.billing.meterEvents.create({ event_name: METERS.voice, identifier: `${app.id}:${p}:voice:${u.voiceTurns}`, timestamp: ts, payload: { stripe_customer_id: app.stripeCustomerId!, value: String(voiceDelta) } });
    }
    if (overageDelta > 0) {
      await stripe.billing.meterEvents.create({ event_name: METERS.overage, identifier: `${app.id}:${p}:overage:${overageNow}`, timestamp: ts, payload: { stripe_customer_id: app.stripeCustomerId!, value: String(overageDelta) } });
    }
    if (voiceDelta > 0 || overageDelta > 0) {
      await db.update(usage).set({ reportedVoice: u.voiceTurns, reportedOverage: overageNow }).where(and(eq(usage.appId, app.id), eq(usage.period, p)));
      out.push({ app: app.id, voice: Math.max(0, voiceDelta), overage: Math.max(0, overageDelta) });
    }
  }
  return out;
}

/** The Developer plan covers ONE app: only the owner's oldest free app may use the API. */
export async function freeAppAllowed(db: DB, app: AppRow): Promise<boolean> {
  if (app.plan !== 'developer') return true;
  const free = await db.select({ id: apps.id, createdAt: apps.createdAt }).from(apps).where(and(eq(apps.ownerId, app.ownerId), eq(apps.plan, 'developer')));
  free.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return free[0]?.id === app.id;
}
