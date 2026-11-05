import Stripe from 'stripe';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb, type DB } from '@/db';
import { managedRequests } from '@/db/schema';
import { createApp, createKey, getApp, getUsage, meter, saveSkill, setPlan, upsertUser } from '@/lib/apps';
import { applyEvent, createCheckout, createManagedCheckout, freeAppAllowed, LOOKUP, reportUsage, resetPriceCache, verifyEvent, type StripeLike } from '@/lib/billing';
import { handleIntent } from '@/lib/intent';
import { period } from '@/lib/plans';
import skill from '../../../examples/notes-app/entoli.skill.json';

let db: DB;
beforeAll(async () => { db = await memoryDb(); });
beforeEach(() => resetPriceCache());

const real = new Stripe('sk_test_not_used_for_network');

function fakeStripe() {
  const sub = (plan: 'l1' | 'l2', status = 'active') => ({
    id: 'sub_1', status, customer: 'cus_1', metadata: {},
    items: { data: [{ price: { lookup_key: plan === 'l1' ? LOOKUP.l1 : LOOKUP.l2 } }, { price: { lookup_key: LOOKUP.overage } }] },
  });
  const f = {
    prices: { list: vi.fn(async () => ({ data: Object.values(LOOKUP).map((k) => ({ id: `price_${k}`, lookup_key: k })) })) },
    customers: { create: vi.fn(async () => ({ id: 'cus_1' })) },
    checkout: { sessions: { create: vi.fn(async (p: { mode: string }) => ({ id: 'cs_1', url: `https://checkout.stripe.test/${p.mode}` })) } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.test/p' })) } },
    subscriptions: { retrieve: vi.fn(async () => sub('l2')) },
    billing: { meterEvents: { create: vi.fn(async () => ({})) } },
    webhooks: real.webhooks,
    sub,
  };
  return f as typeof f & StripeLike;
}

async function newApp(plan: 'developer' | 'l1' | 'l2' = 'developer') {
  const u = await upsertUser(db, { githubId: `g${Math.random()}`, login: 'dev', email: 'dev@example.com' });
  const { app } = await createApp(db, u.id, { name: 'Fieldnotes' });
  if (plan !== 'developer') await setPlan(db, app.id, plan, { id: 'sub_1', status: 'active' });
  return { user: u, app: (await getApp(db, u.id, app.id))! };
}

describe('checkout', () => {
  it('creates one customer per app and a subscription with flat + metered prices', async () => {
    const s = fakeStripe();
    const { user, app } = await newApp();
    const url = await createCheckout(db, s, { app, user, plan: 'l2', origin: 'https://entoli.dev' });
    expect(url).toBe('https://checkout.stripe.test/subscription');
    expect(s.customers.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { appId: app.id, userId: user.id } }), { idempotencyKey: `customer-${app.id}` });
    const params = (s.checkout.sessions.create as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0]![0];
    expect(params).toMatchObject({
      mode: 'subscription', customer: 'cus_1', client_reference_id: app.id,
      line_items: [{ price: 'price_entoli_l2_monthly', quantity: 1 }, { price: 'price_entoli_voice_l2' }, { price: 'price_entoli_text_overage' }],
      subscription_data: { metadata: { appId: app.id, plan: 'l2' } },
      success_url: `https://entoli.dev/dashboard/apps/${app.id}/billing?checkout=success`,
    });
    expect((await getApp(db, user.id, app.id))!.stripeCustomerId).toBe('cus_1');
    // The redirect alone never changes the plan.
    expect((await getApp(db, user.id, app.id))!.plan).toBe('developer');
  });

  it('fails clearly when the Stripe prices are not set up', async () => {
    const s = fakeStripe();
    s.prices.list = vi.fn(async () => ({ data: [] })) as never;
    const { user, app } = await newApp();
    await expect(createCheckout(db, s, { app, user, plan: 'l1', origin: 'x' })).rejects.toThrow(/stripe-setup/);
  });
});

describe('webhook', () => {
  const secret = 'whsec_test_secret';
  const sign = (event: unknown) => {
    const payload = JSON.stringify(event);
    return { payload, header: real.webhooks.generateTestHeaderString({ payload, secret }) };
  };

  it('rejects unsigned or tampered payloads', () => {
    const s = fakeStripe();
    const { payload, header } = sign({ id: 'evt_1', type: 'ping', data: { object: {} } });
    expect(() => verifyEvent(s, payload, null, secret)).toThrow(/missing/);
    expect(() => verifyEvent(s, payload.replace('ping', 'pong'), header, secret)).toThrow();
    expect(verifyEvent(s, payload, header, secret).id).toBe('evt_1');
  });

  it('sets the plan from a completed checkout, and drops to Developer when the subscription ends', async () => {
    const s = fakeStripe();
    const { user, app } = await newApp();
    const done = sign({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', metadata: { appId: app.id, plan: 'l2', kind: 'plan' } } } });
    expect(await applyEvent(db, s, verifyEvent(s, done.payload, done.header, secret))).toBe('plan l2');
    expect((await getApp(db, user.id, app.id))).toMatchObject({ plan: 'l2', subscriptionStatus: 'active', stripeSubscriptionId: 'sub_1' });

    const unpaid = sign({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: { ...s.sub('l2', 'unpaid'), metadata: { appId: app.id } } } });
    await applyEvent(db, s, verifyEvent(s, unpaid.payload, unpaid.header, secret));
    expect((await getApp(db, user.id, app.id))!.plan).toBe('developer');

    const back = sign({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: { ...s.sub('l1'), metadata: { appId: app.id } } } });
    await applyEvent(db, s, verifyEvent(s, back.payload, back.header, secret));
    expect((await getApp(db, user.id, app.id))!.plan).toBe('l1');

    const gone = sign({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { ...s.sub('l1', 'canceled'), metadata: { appId: app.id } } } });
    await applyEvent(db, s, verifyEvent(s, gone.payload, gone.header, secret));
    expect((await getApp(db, user.id, app.id))).toMatchObject({ plan: 'developer', subscriptionStatus: 'canceled', stripeSubscriptionId: null });
  });

  it('marks a managed setup request paid', async () => {
    const s = fakeStripe();
    const { user, app } = await newApp();
    expect(await createManagedCheckout(db, s, { user, appId: app.id, notes: 'Next.js app, launch in May', origin: 'https://entoli.dev' })).toBe('https://checkout.stripe.test/payment');
    const [req] = await db.select().from(managedRequests);
    expect(req).toMatchObject({ status: 'pending_payment', stripeSessionId: 'cs_1', notes: 'Next.js app, launch in May' });
    const paid = sign({ id: 'evt_6', type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', metadata: { kind: 'managed', requestId: req!.id } } } });
    await applyEvent(db, s, verifyEvent(s, paid.payload, paid.header, secret));
    const [after] = await db.select().from(managedRequests);
    expect(after!.status).toBe('paid');
  });
});

describe('usage reporting', () => {
  it('reports only the deltas, with identifiers that make retries safe', async () => {
    const s = fakeStripe();
    const { app } = await newApp('l1');
    await newApp(); // a free app: never reported
    const { apps } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(apps).set({ stripeCustomerId: 'cus_9' }).where(eq(apps.id, app.id));
    await meter(db, app.id, { text: 25_010, voice: 7 });

    const first = await reportUsage(db, s);
    expect(first).toEqual([{ app: app.id, voice: 7, overage: 10 }]);
    const p = period();
    expect(s.billing.meterEvents.create).toHaveBeenCalledWith(expect.objectContaining({ event_name: 'entoli_voice_turns', identifier: `${app.id}:${p}:voice:7`, payload: { stripe_customer_id: 'cus_9', value: '7' } }));
    expect(s.billing.meterEvents.create).toHaveBeenCalledWith(expect.objectContaining({ event_name: 'entoli_text_overage', identifier: `${app.id}:${p}:overage:10`, payload: { stripe_customer_id: 'cus_9', value: '10' } }));

    expect(await reportUsage(db, s)).toEqual([]); // nothing new
    await meter(db, app.id, { voice: 2, text: 5 });
    expect(await reportUsage(db, s)).toEqual([{ app: app.id, voice: 2, overage: 5 }]);
    expect(await getUsage(db, app.id)).toMatchObject({ reportedVoice: 9, reportedOverage: 15 });
  });
});

describe('the Developer plan covers one app', () => {
  it('lets only the oldest free app use the API', async () => {
    const u = await upsertUser(db, { githubId: 'one-app', login: 'solo' });
    const { app: first } = await createApp(db, u.id, { name: 'First' });
    const { app: second } = await createApp(db, u.id, { name: 'Second' });
    expect(await freeAppAllowed(db, (await getApp(db, u.id, first.id))!)).toBe(true);
    expect(await freeAppAllowed(db, (await getApp(db, u.id, second.id))!)).toBe(false);

    // Through the API: the second app is refused until it is upgraded.
    await setPlan(db, second.id, 'l2', { id: 's', status: 'active' });
    expect((await saveSkill(db, u.id, second.id, skill, 'published')).ok).toBe(true);
    const { key } = await createKey(db, u.id, second.id);
    await setPlan(db, second.id, 'developer');
    const r = await handleIntent(db, { key, origin: null, body: { phrase: 'x', channel: 'text', acts: [] } }, { modelAvailable: false });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/one app/);
  });
});
