'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { createApp, createKey, deleteApp, getApp, revokeKey, saveSkill, setPreviewUrl, setRepo, skillOf } from '@/lib/apps';
import { signOut } from '@/lib/auth';
import { requireUser } from '@/lib/session';
import type { KnowledgeEntry, Skill } from '@entoli/sdk/skill';

const q = (s: string) => encodeURIComponent(s.slice(0, 300));

export async function createAppAction(form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  let id: string;
  try {
    const { app } = await createApp(db, user.id, { name: String(form.get('name') ?? ''), repo: String(form.get('repo') ?? '') });
    id = app.id;
  } catch (e) {
    redirect(`/dashboard?error=${q((e as Error).message)}`);
  }
  redirect(`/dashboard/apps/${id}/map`);
}

export async function deleteAppAction(appId: string) {
  const user = await requireUser();
  await deleteApp(await getDb(), user.id, appId);
  redirect('/dashboard');
}

export async function setRepoAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const { parseRepo } = await import('@/lib/apps');
  const repo = parseRepo(String(form.get('repo') ?? ''));
  if (!repo) redirect(`/dashboard/apps/${appId}/map?error=${q('Repository must look like owner/name.')}`);
  const app = await getApp(db, user.id, appId);
  await setRepo(db, user.id, appId, repo, app?.repo === repo ? app.installationId : null);
  revalidatePath(`/dashboard/apps/${appId}`);
}

export async function setPreviewAction(appId: string, form: FormData) {
  const user = await requireUser();
  try {
    await setPreviewUrl(await getDb(), user.id, appId, String(form.get('url') ?? '').trim() || null);
  } catch (e) {
    redirect(`/dashboard/apps/${appId}/test?error=${q((e as Error).message)}`);
  }
  revalidatePath(`/dashboard/apps/${appId}`);
}

export async function saveSkillAction(appId: string, form: FormData) {
  const user = await requireUser();
  const raw = String(form.get('skill') ?? '');
  const status = form.get('publish') ? 'published' : 'draft';
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { redirect(`/dashboard/apps/${appId}/skill?error=${q(`Not valid JSON: ${(e as Error).message}`)}`); }
  const r = await saveSkill(await getDb(), user.id, appId, parsed, status);
  if (!r.ok) redirect(`/dashboard/apps/${appId}/skill?error=${q(r.errors.slice(0, 6).join(' · '))}`);
  redirect(`/dashboard/apps/${appId}/skill?saved=${status}`);
}

async function editSkill(appId: string, fn: (s: Skill) => void, back: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const skill = skillOf(app);
  if (!skill) redirect(`/dashboard/apps/${appId}/skill?error=${q('Create or analyze a skill first.')}`);
  fn(skill);
  const r = await saveSkill(db, user.id, appId, skill, app.skillStatus === 'published' ? 'published' : 'draft');
  if (!r.ok) redirect(`${back}?error=${q(r.errors.join(' · '))}`);
  revalidatePath(back);
}

export async function addKnowledgeAction(appId: string, form: FormData) {
  const entry: KnowledgeEntry = {
    topic: String(form.get('topic') ?? '').trim(),
    can: form.get('can') === 'yes',
    answer: String(form.get('answer') ?? '').trim(),
  };
  if (!entry.answer) entry.answer = entry.can ? `Yes, it can ${entry.topic}.` : `No, it can't ${entry.topic}.`;
  await editSkill(appId, (s) => { s.knowledge.push(entry); }, `/dashboard/apps/${appId}/knowledge`);
}

export async function removeKnowledgeAction(appId: string, index: number) {
  await editSkill(appId, (s) => { s.knowledge.splice(index, 1); }, `/dashboard/apps/${appId}/knowledge`);
}

/** Returns the new key to the form that asked; it is never put in a URL, cookie or log. */
export async function createKeyAction(appId: string, _prev: { key?: string; error?: string }, form: FormData): Promise<{ key?: string; error?: string }> {
  const user = await requireUser();
  try {
    const { key } = await createKey(await getDb(), user.id, appId, String(form.get('label') ?? 'default'));
    revalidatePath(`/dashboard/apps/${appId}/keys`);
    return { key };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function revokeKeyAction(appId: string, keyId: string) {
  const user = await requireUser();
  await revokeKey(await getDb(), user.id, appId, keyId);
  revalidatePath(`/dashboard/apps/${appId}/keys`);
}

export async function signOutAction() {
  await signOut({ redirectTo: '/' });
}


export async function startAnalysisAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { queueAnalysis, runAnalysis } = await import('@/lib/analysis');
  const q = await queueAnalysis(db, app);
  if ('error' in q) redirect(`/dashboard/apps/${appId}/analyze?error=${encodeURIComponent(q.error)}`);
  const { after } = await import('next/server');
  // Runs after the response is sent; the page polls the job row.
  after(() => runAnalysis(db, app, q.id));
  redirect(`/dashboard/apps/${appId}/analyze`);
}

export async function setOriginsAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const raw = String(form.get('origins') ?? '').split(/[\s,]+/).map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
  const bad = raw.filter((o) => !/^(https?:\/\/[a-z0-9.-]+(:\d+)?|\*\.[a-z0-9.-]+)$/i.test(o));
  if (bad.length) redirect(`/dashboard/apps/${appId}/keys?error=${encodeURIComponent(`Not an origin: ${bad.join(', ')}`)}`);
  const { apps } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  await db.update(apps).set({ allowedOrigins: [...new Set(raw)].slice(0, 20) }).where(eq(apps.id, appId));
  revalidatePath(`/dashboard/apps/${appId}/keys`);
}

async function origin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const { headers } = await import('next/headers');
  const h = await headers();
  return `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('x-forwarded-host') ?? h.get('host')}`;
}

export async function checkoutAction(appId: string, plan: 'l1' | 'l2') {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { createCheckout, getStripe } = await import('@/lib/billing');
  const stripe = getStripe();
  if (!stripe) redirect(`/dashboard/apps/${appId}/billing?error=${q('Billing is not configured on this deployment.')}`);
  let url: string;
  try { url = await createCheckout(db, stripe, { app, user, plan, origin: await origin() }); }
  catch (e) { redirect(`/dashboard/apps/${appId}/billing?error=${q((e as Error).message)}`); }
  redirect(url);
}

export async function portalAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { createPortal, getStripe } = await import('@/lib/billing');
  const stripe = getStripe();
  if (!stripe) redirect(`/dashboard/apps/${appId}/billing?error=${q('Billing is not configured on this deployment.')}`);
  let url: string;
  try { url = await createPortal(stripe, app, await origin()); }
  catch (e) { redirect(`/dashboard/apps/${appId}/billing?error=${q((e as Error).message)}`); }
  redirect(url);
}

export async function managedAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { createManagedCheckout, getStripe } = await import('@/lib/billing');
  const stripe = getStripe();
  if (!stripe) redirect(`/dashboard/apps/${appId}/billing?error=${q('Billing is not configured on this deployment.')}`);
  let url: string;
  try { url = await createManagedCheckout(db, stripe, { user, appId, notes: String(form.get('notes') ?? ''), origin: await origin() }); }
  catch (e) { redirect(`/dashboard/apps/${appId}/billing?error=${q((e as Error).message)}`); }
  redirect(url);
}

/** Local development only: switch plans without Stripe to try the limits. */
export async function devPlanAction(appId: string, plan: 'developer' | 'l1' | 'l2') {
  if (process.env.NODE_ENV === 'production' || process.env.STRIPE_SECRET_KEY) redirect(`/dashboard/apps/${appId}/billing`);
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { setPlan } = await import('@/lib/apps');
  await setPlan(db, appId, plan, { id: null, status: plan === 'developer' ? null : 'active' });
  revalidatePath(`/dashboard/apps/${appId}`);
}

export async function startIntegrationAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { integrationAllowed, parseAnswers, startIntegration, generateIntegration, dirFiles } = await import('@/lib/integration');
  const blocked = integrationAllowed(app);
  if (blocked) redirect(`/dashboard/apps/${appId}/integrate?error=${q(blocked)}`);
  const skill = skillOf(app);
  if (!skill) redirect(`/dashboard/apps/${appId}/integrate?error=${q('Analyze the repository first.')}`);
  const answers = parseAnswers({ ...Object.fromEntries(form.entries()), features: form.getAll('features') }, skill);
  if ('error' in answers) redirect(`/dashboard/apps/${appId}/integrate?error=${q(answers.error)}`);
  const row = await startIntegration(db, app, answers);
  const { after } = await import('next/server');
  const { fetchRepo } = await import('@/lib/repo-fetch');
  after(async () => {
    let fetched: Awaited<ReturnType<typeof fetchRepo>> | null = null;
    try {
      fetched = await fetchRepo(app.repo!, { installationId: app.installationId });
      await generateIntegration(db, app, row.id, { files: dirFiles(fetched.dir) });
    } catch (e) {
      const { integrations } = await import('@/db/schema');
      const { eq } = await import('drizzle-orm');
      await db.update(integrations).set({ status: 'failed', error: (e as Error).message }).where(eq(integrations.id, row.id));
    } finally {
      await fetched?.cleanup().catch(() => {});
    }
  });
  redirect(`/dashboard/apps/${appId}/integrate`);
}

export async function changeStatusAction(appId: string, integrationId: string, changeId: string, status: 'approved' | 'rejected' | 'pending') {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { setChangeStatus } = await import('@/lib/integration');
  const { integrations } = await import('@/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const [owned] = await db.select({ id: integrations.id }).from(integrations).where(and(eq(integrations.id, integrationId), eq(integrations.appId, appId)));
  if (!owned) redirect(`/dashboard/apps/${appId}/integrate`);
  await setChangeStatus(db, integrationId, changeId, status);
  revalidatePath(`/dashboard/apps/${appId}/integrate`);
}

export async function openPrAction(appId: string, integrationId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { openPullRequest } = await import('@/lib/integration');
  let url: string;
  try { url = await openPullRequest(db, app, integrationId); }
  catch (e) { redirect(`/dashboard/apps/${appId}/integrate?error=${q((e as Error).message)}`); }
  redirect(`/dashboard/apps/${appId}/integrate?pr=${encodeURIComponent(url)}`);
}
