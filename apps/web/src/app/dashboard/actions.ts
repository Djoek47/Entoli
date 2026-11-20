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

export async function startProjectAction(form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const how = String(form.get('how') ?? 'blank');
  let id: string;
  try {
    const { startBlank, startRebuild } = await import('@/lib/project');
    const { parseRepoSpec } = await import('@/lib/apps');
    const name = String(form.get('name') ?? '');
    if (how === 'rebuild') {
      const spec = parseRepoSpec(String(form.get('repo') ?? ''));
      if (!spec) throw new Error('Choose the original repository (owner/name, or owner/name#folder for an app inside a monorepo).');
      id = (await startRebuild(db, user.id, { name, repo: spec.repo, subdir: spec.subdir })).appId;
    } else {
      const t = String(form.get('template') ?? 'static');
      id = (await startBlank(db, user.id, { name, description: String(form.get('description') ?? ''), template: t === 'vite' || t === 'next' ? t : 'static' })).appId;
    }
  } catch (e) {
    redirect(`/dashboard?error=${q((e as Error).message)}`);
  }
  redirect(`/dashboard/apps/${id}/project`);
}

/** For the voice act: starts a blank project and returns where to go (no redirect, so the bar can say what happened). */
export async function startBlankByVoiceAction(description: string, name?: string): Promise<{ appId: string; note?: string }> {
  const user = await requireUser();
  const db = await getDb();
  const { startBlank, nameFromDescription } = await import('@/lib/project');
  const r = await startBlank(db, user.id, { name: name?.trim() || nameFromDescription(description), description });
  return { appId: r.appId, ...(r.note ? { note: r.note } : {}) };
}

export async function startOriginalSandboxAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { queueSandbox, bootSandbox, stopOthers } = await import('@/lib/sandbox-boot');
  const qd = await queueSandbox(db, app, 'original');
  if ('error' in qd) redirect(`/dashboard/apps/${appId}/project?error=${q(qd.error)}`);
  const { after } = await import('next/server');
  after(async () => { await stopOthers(db, app, qd.id, undefined, 'original'); await bootSandbox(db, app, qd.id, { role: 'original' }); });
  redirect(`/dashboard/apps/${appId}/project`);
}

export async function checkOriginalAction(appId: string, sandboxId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { runChecks } = await import('@/lib/sandbox-boot');
  try { await runChecks(db, app, sandboxId); }
  catch (e) { redirect(`/dashboard/apps/${appId}/project?error=${q((e as Error).message)}`); }
  revalidatePath(`/dashboard/apps/${appId}/project`);
}

export async function deleteAppAction(appId: string) {
  const user = await requireUser();
  await deleteApp(await getDb(), user.id, appId);
  redirect('/dashboard');
}

export async function setRepoAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const { parseRepoSpec } = await import('@/lib/apps');
  const spec = parseRepoSpec(String(form.get('repo') ?? ''));
  if (!spec) redirect(`/dashboard/apps/${appId}/map?error=${q('Repository must look like owner/name, or owner/name#folder for an app inside a monorepo.')}`);
  const app = await getApp(db, user.id, appId);
  await setRepo(db, user.id, appId, spec.repo, app?.repo === spec.repo ? app.installationId : null, spec.subdir);
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

export async function runTestAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { runFromDashboard } = await import('@/lib/test-runs');
  try { await runFromDashboard(db, app); }
  catch (e) { redirect(`/dashboard/apps/${appId}/test?error=${q((e as Error).message)}`); }
  revalidatePath(`/dashboard/apps/${appId}/test`);
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
  const { hit } = await import('@/lib/ratelimit');
  if (!(await hit(db, `analyze:${user.id}`, 10, 3_600_000)).ok) redirect(`/dashboard/apps/${appId}/analyze?error=${encodeURIComponent('Ten analyses an hour at most. Try again later.')}`);
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
  const { hit } = await import('@/lib/ratelimit');
  if (!(await hit(db, `integrate:${user.id}`, 6, 3_600_000)).ok) redirect(`/dashboard/apps/${appId}/integrate?error=${q('Six integrations an hour at most. Try again later.')}`);
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

export async function setActLayerAction(appId: string, act: string, form: FormData) {
  const layer = String(form.get('layer') ?? '');
  if (layer !== 'L1' && layer !== 'L2' && layer !== 'off') return;
  await editSkill(appId, (s) => {
    const a = s.acts.find((x) => x.name === act);
    if (!a) return;
    if (layer === s.layer) delete a.layer; else a.layer = layer;
  }, `/dashboard/apps/${appId}/map`);
}

/** For the voice tool: publish the current skill. Returns a message instead of redirecting. */
export async function publishSkillAction(appId: string): Promise<{ ok: boolean; message: string }> {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) return { ok: false, message: 'App not found.' };
  const r = await saveSkill(db, user.id, appId, app.skill, 'published');
  revalidatePath(`/dashboard/apps/${appId}`);
  return r.ok ? { ok: true, message: 'Published.' } : { ok: false, message: r.errors.join(' ') };
}

/** Returns the token to the form that asked; never put in a URL, cookie or log. */
export async function createMcpTokenAction(appId: string, _prev: { token?: string; error?: string }, form: FormData): Promise<{ token?: string; error?: string }> {
  const user = await requireUser();
  try {
    const { createMcpToken } = await import('@/lib/mcp');
    const { token } = await createMcpToken(await getDb(), user.id, appId, String(form.get('label') ?? 'agent'));
    revalidatePath(`/dashboard/apps/${appId}/keys`);
    return { token };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function revokeMcpTokenAction(appId: string, tokenId: string) {
  const user = await requireUser();
  const { revokeMcpToken } = await import('@/lib/mcp');
  await revokeMcpToken(await getDb(), user.id, appId, tokenId);
  revalidatePath(`/dashboard/apps/${appId}/keys`);
}

export async function startSandboxAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { queueSandbox, bootSandbox, stopOthers } = await import('@/lib/sandbox-boot');
  const qd = await queueSandbox(db, app);
  if ('error' in qd) redirect(`/dashboard/apps/${appId}/sandbox?error=${encodeURIComponent(qd.error)}`);
  const { after } = await import('next/server');
  after(async () => { await stopOthers(db, app, qd.id); await bootSandbox(db, app, qd.id); });
  redirect(`/dashboard/apps/${appId}/sandbox`);
}

export async function runChecksAction(appId: string, sandboxId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { runChecks } = await import('@/lib/sandbox-boot');
  try { await runChecks(db, app, sandboxId); }
  catch (e) { redirect(`/dashboard/apps/${appId}/sandbox?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
  revalidatePath(`/dashboard/apps/${appId}/sandbox`);
}

export async function stopSandboxAction(appId: string, sandboxId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { stopSandbox } = await import('@/lib/sandbox-boot');
  await stopSandbox(db, app, sandboxId);
  revalidatePath(`/dashboard/apps/${appId}/sandbox`);
}

export async function extractDesignAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { extractFromRepo, sampleFromUrl } = await import('@/lib/design');
  const { latestSandbox } = await import('@/lib/sandbox-boot');
  try {
    await extractFromRepo(db, app);
    // If a sandbox is running, also look at what people actually see.
    const [sbx] = await latestSandbox(db, appId);
    if (sbx?.status === 'ready' && sbx.url) await sampleFromUrl(db, (await getApp(db, user.id, appId))!, sbx.url);
  } catch (e) { redirect(`/dashboard/apps/${appId}/design?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
  revalidatePath(`/dashboard/apps/${appId}/design`);
}

export async function sampleDesignAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { sampleFromUrl } = await import('@/lib/design');
  const { latestSandbox } = await import('@/lib/sandbox-boot');
  try {
    const [sbx] = await latestSandbox(db, appId);
    const url = sbx?.status === 'ready' && sbx.url ? sbx.url : app.previewUrl;
    if (!url) throw new Error('Start the test sandbox, or set a preview URL (Test tab), so there is a running app to look at.');
    await sampleFromUrl(db, app, url);
  } catch (e) { redirect(`/dashboard/apps/${appId}/design?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
  revalidatePath(`/dashboard/apps/${appId}/design`);
}

export async function tweakDesignAction(appId: string, form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { tweakDesign } = await import('@/lib/design');
  try {
    const r = await tweakDesign(db, app, String(form.get('instruction') ?? ''));
    if (!r.understood) redirect(`/dashboard/apps/${appId}/design?error=${encodeURIComponent('I did not understand that. Try "rounder", "no shadow", "make the accent blue", or "use #2563eb as the accent".')}`);
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e;
    redirect(`/dashboard/apps/${appId}/design?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
  }
  revalidatePath(`/dashboard/apps/${appId}/design`);
}

export async function resetDesignTweaksAction(appId: string) {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) redirect('/dashboard');
  const { resetTweaks } = await import('@/lib/design');
  await resetTweaks(db, app);
  revalidatePath(`/dashboard/apps/${appId}/design`);
}

// ---- the proposal conversation ----

/** Returns what to say (voice tool). */
export async function proposeAction(appId: string): Promise<{ spoken: string; count: number }> {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) throw new Error('App not found.');
  const { proposeFor } = await import('@/lib/proposal');
  const p = await proposeFor(db, app);
  revalidatePath(`/dashboard/apps/${appId}`);
  return { spoken: p.spoken, count: p.items.length };
}

export async function acceptProposalAction(appId: string): Promise<{ changed: number }> {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) throw new Error('App not found.');
  const { acceptProposal } = await import('@/lib/proposal');
  const r = await acceptProposal(db, app);
  revalidatePath(`/dashboard/apps/${appId}`);
  return r;
}

export async function undoProposalAction(appId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) return;
  const { undoProposal } = await import('@/lib/proposal');
  await undoProposal(db, app);
  revalidatePath(`/dashboard/apps/${appId}`);
}

export async function whyAction(appId: string, act: string): Promise<string> {
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app) throw new Error('App not found.');
  const { proposalOf, explain } = await import('@/lib/proposal');
  const p = proposalOf(app);
  if (!p) return 'Ask me what to expose first, and then I can explain each choice.';
  return explain(p, act);
}

// Page buttons (they only need to do the thing; the page re-renders).
export async function proposeFormAction(appId: string) {
  try { await proposeAction(appId); } catch (e) { redirect(`/dashboard/apps/${appId}/map?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
}
export async function acceptProposalFormAction(appId: string) {
  try { await acceptProposalAction(appId); } catch (e) { redirect(`/dashboard/apps/${appId}/map?error=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
}
export async function undoProposalFormAction(appId: string) {
  await undoProposalAction(appId);
}
