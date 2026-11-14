'use client';
import { useActionState, useEffect, useState } from 'react';
import { createMcpTokenAction } from '../../../actions';

export function McpConnect({ appId, allowed }: { appId: string; allowed: boolean }) {
  const [state, action, pending] = useActionState(createMcpTokenAction.bind(null, appId), {});
  const [origin, setOrigin] = useState('https://entoli.dev');
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}/api/mcp`;
  const t = state.token ?? 'em_…your token…';
  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>Connect your coding agent</h3>
      <p className="muted" style={{ margin: 0 }}>Your own agent (Claude Code, Cursor, anything that speaks MCP) does the coding. Entoli tells it what to wire, keeps it inside the lines, and brings every change back here as a diff you approve. It cannot write to your repository.</p>
      {!allowed ? <p className="notice err">Part of the L2 plan. <a href={`/dashboard/apps/${appId}/billing`}>See plans</a></p> : (
        <>
          {state.token ? <div className="notice"><strong>Copy this token now. It will not be shown again.</strong><div className="secret" style={{ marginTop: 8 }}>{state.token}</div></div> : null}
          {state.error ? <p className="notice err">{state.error}</p> : null}
          <form action={action} className="row">
            <label>Label<input name="label" defaultValue="Claude Code" maxLength={40} /></label>
            <button className="btn primary" disabled={pending}>Create agent token</button>
          </form>
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How to add it</summary>
            <p className="muted">Claude Code:</p>
            <pre className="block">{`claude mcp add --transport http entoli ${url} \\\n  --header "Authorization: Bearer ${t}"`}</pre>
            <p className="muted">Cursor (<code>.cursor/mcp.json</code>):</p>
            <pre className="block">{JSON.stringify({ mcpServers: { entoli: { url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2)}</pre>
            <p className="muted">Then ask your agent: “Use the Entoli MCP server to integrate Entoli into this app.”</p>
          </details>
        </>
      )}
    </section>
  );
}
