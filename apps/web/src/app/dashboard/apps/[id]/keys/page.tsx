import { revokeKeyAction } from '../../../actions';
import { loadApp } from '@/lib/app-page';
import { listKeys } from '@/lib/apps';
import { NewKey } from './NewKey';

export const metadata = { title: 'Keys' };

export default async function KeysPage({ params }: { params: Promise<{ id: string }> }) {
  const { app, db, user } = await loadApp(params);
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
    </div>
  );
}
