import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { upsertUser } from './apps';
import { auth, authConfigured } from './auth';

/**
 * The signed-in user, or a redirect to /login.
 * DEV ONLY: with no GitHub OAuth configured and not in production, a local
 * "dev" user is used so the dashboard can be tried without any account.
 */
export async function requireUser() {
  const db = await getDb();
  if (!authConfigured && process.env.NODE_ENV !== 'production') {
    return upsertUser(db, { githubId: 'dev', login: 'dev', name: 'Local developer' });
  }
  const s = (await auth()) as { uid?: string } | null;
  if (!s?.uid) redirect('/login');
  const [u] = await db.select().from(users).where(eq(users.id, s.uid));
  if (!u) redirect('/login');
  return u;
}
