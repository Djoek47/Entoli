import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  githubId: text('github_id').notNull(),
  login: text('login').notNull(),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: created(),
}, (t) => [uniqueIndex('users_github_id').on(t.githubId)]);

export const PLANS = ['developer', 'l1', 'l2'] as const;
export type PlanId = (typeof PLANS)[number];

export const apps = pgTable('apps', {
  id: id(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  repo: text('repo'),
  installationId: text('installation_id'),
  plan: text('plan').$type<PlanId>().notNull().default('developer'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionStatus: text('subscription_status'),
  skill: jsonb('skill'),
  skillStatus: text('skill_status').$type<'none' | 'draft' | 'published'>().notNull().default('none'),
  previewUrl: text('preview_url'),
  /** Origins allowed to use this app's key from a browser. Empty: any origin. */
  allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
  createdAt: created(),
}, (t) => [index('apps_owner').on(t.ownerId)]);

export const apiKeys = pgTable('api_keys', {
  id: id(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  label: text('label').notNull().default('default'),
  /** First characters, shown in the dashboard: ek_live_ab12… */
  prefix: text('prefix').notNull(),
  /** sha256 of the full key. The key itself is never stored. */
  hash: text('hash').notNull(),
  createdAt: created(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [uniqueIndex('api_keys_hash').on(t.hash), index('api_keys_app').on(t.appId)]);

/** One row per app per calendar month (UTC). */
export const usage = pgTable('usage', {
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  textIntents: integer('text_intents').notNull().default(0),
  voiceTurns: integer('voice_turns').notNull().default(0),
  modelCalls: integer('model_calls').notNull().default(0),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
  tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
  /** Our model cost, in micro-dollars. */
  costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  /** What has already been reported to Stripe, so reports are deltas. */
  reportedVoice: integer('reported_voice').notNull().default(0),
  reportedOverage: integer('reported_overage').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.appId, t.period] })]);

export const analyses = pgTable('analyses', {
  id: id(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
  filesScanned: integer('files_scanned').notNull().default(0),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costMicros: integer('cost_micros').notNull().default(0),
  usedModel: boolean('used_model').notNull().default(false),
  log: jsonb('log').$type<string[]>().notNull().default([]),
  error: text('error'),
  createdAt: created(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const managedRequests = pgTable('managed_requests', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  appId: text('app_id').references(() => apps.id, { onDelete: 'set null' }),
  status: text('status').$type<'pending_payment' | 'paid' | 'in_progress' | 'done' | 'cancelled'>().notNull().default('pending_payment'),
  stripeSessionId: text('stripe_session_id'),
  notes: text('notes'),
  createdAt: created(),
});

export type IntegrationChange = { id: string; title: string; file: string; diff: string; content: string; status: 'pending' | 'approved' | 'rejected' };

export const integrations = pgTable('integrations', {
  id: id(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
  changes: jsonb('changes').$type<IntegrationChange[]>().notNull().default([]),
  status: text('status').$type<'interview' | 'generated' | 'pr_opened' | 'failed'>().notNull().default('interview'),
  prUrl: text('pr_url'),
  error: text('error'),
  createdAt: created(),
});

export const testRuns = pgTable('test_runs', {
  id: id(),
  appId: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  coverage: integer('coverage').notNull().default(0),
  report: jsonb('report'),
  createdAt: created(),
});

/** Fixed-window rate limit counters (per key per minute). */
export const rateLimits = pgTable('rate_limits', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull().default(0),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
});
