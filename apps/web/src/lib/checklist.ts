/**
 * The first-run checklist: where this app is on the way from "just created" to
 * "shipped", and what to do next. Computed from what exists, never stored, so it
 * cannot drift from reality.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { DB } from '@/db';
import { apps, integrations, mcpTokens, sandboxes } from '@/db/schema';
import { PLANS } from './plans';
import { proposalOf } from './proposal';
import { isProject } from './project';

type AppRow = typeof apps.$inferSelect;

export type Step = { id: string; title: string; done: boolean; href: string; hint: string };

export async function checklist(db: DB, app: AppRow): Promise<{ steps: Step[]; next: Step | null; doneCount: number }> {
  const base = `/dashboard/apps/${app.id}`;
  const project = isProject(app);
  const l2 = PLANS[app.plan].integration;
  const [ints, sbxs, tokens] = await Promise.all([
    db.select({ status: integrations.status, changes: integrations.changes }).from(integrations).where(eq(integrations.appId, app.id)),
    db.select({ id: sandboxes.id }).from(sandboxes).where(and(eq(sandboxes.appId, app.id), ne(sandboxes.status, 'failed'))),
    db.select({ id: mcpTokens.id }).from(mcpTokens).where(eq(mcpTokens.appId, app.id)),
  ]);
  const hasSkill = !!app.skill;
  const exposed = !!proposalOf(app)?.applied;
  const worked = ints.length > 0 || tokens.length > 0;
  const shipped = ints.some((i) => i.status === 'pr_opened') || (project && ints.some((i) => i.changes.some((c) => c.status === 'approved')));

  const steps: Step[] = [
    project
      ? { id: 'start', title: 'Start your project', done: true, href: `${base}/project`, hint: 'Entoli wrote the skill and a starter that runs.' }
      : { id: 'start', title: 'Connect your repository', done: !!app.repo, href: `${base}/map`, hint: 'A public repo works at once; a private one needs the read-only GitHub App.' },
    { id: 'analyze', title: project ? 'Look over the skill' : 'Analyze your app', done: project ? true : hasSkill, href: project ? `${base}/map` : `${base}/analyze`, hint: project ? 'Check the screens and features Entoli drafted.' : 'Entoli reads your code and drafts the skill: your screens and the things people can do.' },
    { id: 'expose', title: 'Choose what Entoli takes over', done: exposed, href: `${base}/map`, hint: l2 ? 'Press Propose: per feature, the AI, the device, or manual, with reasons.' : 'Set each feature to Layer 1, Layer 2 or off in the Map tab.' },
    { id: 'build', title: project ? 'Connect your coding agent' : 'Wire the features', done: worked, href: project ? `${base}/keys` : `${base}/integrate`, hint: l2 ? 'Your agent builds it over MCP; every change waits for your yes.' : 'Export the skill to Claude Code or Cursor (Skill tab), or upgrade to let Entoli integrate it.' },
    { id: 'try', title: 'Try it in the sandbox', done: sbxs.length > 0, href: project ? `${base}/project` : `${base}/sandbox`, hint: 'Your app runs in an isolated window; Entoli walks the map and tries every phrase.' },
    { id: 'ship', title: project ? 'Approve changes and download' : 'Open the pull request', done: shipped, href: project ? `${base}/project` : `${base}/integrate`, hint: project ? 'Approve what your agent built, then download the zip.' : 'One pull request with everything you approved.' },
    { id: 'publish', title: 'Publish the skill', done: app.skillStatus === 'published', href: `${base}/skill`, hint: 'Publishing makes the skill live for your app key.' },
  ];
  const next = steps.find((s) => !s.done) ?? null;
  return { steps, next, doneCount: steps.filter((s) => s.done).length };
}
