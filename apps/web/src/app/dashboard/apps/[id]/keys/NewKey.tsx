'use client';
import { useActionState } from 'react';
import { createKeyAction } from '../../../actions';

export function NewKey({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(createKeyAction.bind(null, appId), {});
  return (
    <div className="stack">
      {state.key ? (
        <div className="notice"><strong>Copy this key now. It will not be shown again.</strong><div className="secret" style={{ marginTop: 8 }}>{state.key}</div></div>
      ) : null}
      {state.error ? <p className="notice err">{state.error}</p> : null}
      <form action={action} className="row card">
        <label>Label<input name="label" defaultValue="production" maxLength={40} /></label>
        <button className="btn primary" disabled={pending}>Create key</button>
      </form>
    </div>
  );
}
