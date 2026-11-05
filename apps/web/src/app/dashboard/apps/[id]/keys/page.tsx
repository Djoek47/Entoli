import { revokeKeyAction, setOriginsAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { listKeys } from '@/lib/apps';
import { NewKey } from './NewKey';

export const metadata = { title: 'Keys' };

export default async function KeysPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { app, db, user } = await loadApp(params);
  const sp = await searchParams;
  const keys = await listKeys(db, user.id, app.id);
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>The app key goes in your front end: <code>mount({'{'} el, skill, key {'}'})</code>. It can only spend this app's intents; it cannot read or change anything here. Only a hash is stored.</p>
      <table><thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>{keys.length === 0 ? <tr><td colSpan={5} className="muted">No keys yet.</td></tr> : keys.map((k) => (
          <tr key={k.id}><td>{k.label}</td><td className="mono">{k.prefix}…</td><td>{k.createdAt.toISOString().slice(0, 10)}</td><td>{k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
            <td>{k.revokedAt ? <span className="pill warn">revoked</span> : <form action={revokeKeyAction.bind(null, app.id, k.id)}><button className="btn small danger">Revoke</button></form>}</td></tr>
        ))}</tbody></table>
      <NewKey appId={app.id} />
      {sp.error ? <p className="notice err">{sp.error}</p> : null}
      <form action={setOriginsAction.bind(null, app.id)} className="card stack">
        <h3 style={{ margin: 0 }}>Allowed origins</h3>
        <p className="muted" style={{ margin: 0 }}>The key is public: it ships in your front end. List the sites allowed to use it (for example <code>https://app.example.com</code> or <code>*.vercel.app</code>). Leave empty to allow any origin.</p>
        <label>Origins<input name="origins" defaultValue={app.allowedOrigins.join(' ')} placeholder="https://app.example.com *.vercel.app" /></label>
        <div><button className="btn">Save origins</button></div>
      </form>
    </div>
  );
}
