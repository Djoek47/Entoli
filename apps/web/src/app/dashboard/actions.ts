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
