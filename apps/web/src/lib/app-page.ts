import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { getApp, skillOf } from './apps';
import { requireUser } from './session';

/** Owner-checked app for a dashboard page. 404 for anyone else. */
export async function loadApp(params: Promise<{ id: string }>) {
  const { id } = await params;
  const user = await requireUser();
  const db = await getDb();
  const app = await getApp(db, user.id, id);
  if (!app) notFound();
  return { user, db, app, skill: skillOf(app) };
}
