/**
 * Sign-in with GitHub (Auth.js). JWT sessions; our own users table is
 * upserted on sign-in. Scopes are read-only identity: repository access is
 * granted separately, per repository, through the GitHub App.
 */
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { getDb } from '@/db';
import { upsertUser } from './apps';

export const authConfigured = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'dev-only-insecure-secret-change-me'),
  providers: authConfigured ? [GitHub({ authorization: { params: { scope: 'read:user user:email' } } })] : [],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile && typeof profile.id !== 'undefined') {
        const p = profile as { id: number | string; login?: string; name?: string; email?: string; avatar_url?: string };
        const db = await getDb();
        const u = await upsertUser(db, { githubId: String(p.id), login: p.login ?? String(p.id), name: p.name ?? null, email: p.email ?? null, avatarUrl: p.avatar_url ?? null });
        token.uid = u.id;
        token.login = u.login;
      }
      return token;
    },
    session({ session, token }) {
      (session as { uid?: string }).uid = token.uid as string | undefined;
      (session as { login?: string }).login = token.login as string | undefined;
      return session;
    },
  },
});
