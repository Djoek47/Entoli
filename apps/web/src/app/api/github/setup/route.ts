// GitHub App "Setup URL": GitHub sends the developer here after installing.
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import { getApp, setRepo } from '@/lib/apps';
import { installationRepos } from '@/lib/github';
import { requireUser } from '@/lib/session';

export async function GET(req: NextRequest) {
  const user = await requireUser();
  const installationId = req.nextUrl.searchParams.get('installation_id');
  const appId = req.nextUrl.searchParams.get('state') ?? '';
  const db = await getDb();
  const app = await getApp(db, user.id, appId);
  if (!app || !installationId || !/^\d+$/.test(installationId)) return NextResponse.redirect(new URL('/dashboard?error=install', req.url));
  // Only keep the installation if it can actually see this app's repository.
  const repos = await installationRepos(installationId).catch(() => [] as string[]);
  const repo = app.repo && repos.includes(app.repo) ? app.repo : repos[0] ?? app.repo;
  if (!repo || !repos.includes(repo)) return NextResponse.redirect(new URL(`/dashboard/apps/${app.id}/map?error=install-repo`, req.url));
  await setRepo(db, user.id, app.id, repo, installationId);
  return NextResponse.redirect(new URL(`/dashboard/apps/${app.id}/map?connected=1`, req.url));
}
