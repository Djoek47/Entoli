import { redirect } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { auth, authConfigured, signIn } from '@/lib/auth';

export const metadata = { title: 'Sign in' };

export default async function Login() {
  if (!authConfigured && process.env.NODE_ENV !== 'production') redirect('/dashboard');
  const s = await auth();
  if (s) redirect('/dashboard');
  return (
    <main className="center">
      <div className="stack" style={{ maxWidth: 380 }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Logo /></div>
        <h1>Bring your app</h1>
        <p className="muted">Sign in with GitHub. Entoli only reads your profile here; repository access is granted later, per repository, read-only.</p>
        {authConfigured ? (
          <form action={async () => { 'use server'; await signIn('github', { redirectTo: '/dashboard' }); }}>
            <button className="btn primary" style={{ width: '100%' }}>Continue with GitHub</button>
          </form>
        ) : (
          <p className="notice err">GitHub sign-in is not configured on this deployment (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET).</p>
        )}
        <p className="muted" style={{ fontSize: 13 }}>By continuing you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>
      </div>
    </main>
  );
}
