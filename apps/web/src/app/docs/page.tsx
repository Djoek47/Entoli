import { DocsNav, Page } from '@/components/Page';

export const metadata = { title: 'Quickstart' };

export default function Quickstart() {
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Docs</div>
      <h1>Make your app operable by intent in 3 steps</h1>
      <DocsNav at="/docs" />
      <ol className="steps">
        <li>
          <h2 className="sub">Get a skill</h2>
          <p>Connect your repository in the <a href="/dashboard">dashboard</a> and press Analyze, or run the analyzer locally. You get <code>entoli.skill.json</code>: the map of your screens, the acts your app can do (each with its blast radius and whether it can be undone) and what it can and can't do. Review it; nothing is published until you say so.</p>
          <pre tabIndex={0}>{`npx entoli analyze ./my-app          # static scan; with ANTHROPIC_API_KEY, Claude reviews the draft`}</pre>
        </li>
        <li>
          <h2 className="sub">Mount the bar</h2>
          <pre tabIndex={0}>{`npm i @entoli/sdk

import { mount } from '@entoli/sdk';
import skill from './entoli.skill.json';

mount({ el: '#entoli', skill, mode: 'voice', key: import.meta.env.VITE_ENTOLI_KEY });`}</pre>
          <p>Layer 1 needs nothing else: every request resolves on the device. For Layer 2 acts (Entoli AI answers), add your public app key from the dashboard; the AI may only choose among acts you set to L2. Prefer your own AI? Pass <code>resolver</code> to <code>mount()</code>.</p>
        </li>
        <li>
          <h2 className="sub">Wire each act to the function that already does it</h2>
          <pre tabIndex={0}>{`import { useEntoli } from '@entoli/sdk/react';

useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), {
  undo: (note) => removeNote(note.id),          // with undo, small things run after a 1.6 s hold
});

useEntoli('settings.email', { email: 'freeText' }, ({ email }) => changeEmail(String(email)), {
  radius: 'external', exact: true, voiceOnly: true, // shows exactly the address; the yes covers only it
});`}</pre>
          <p>Plain JavaScript: <code>defineAct(name, slots, handler, options)</code> works the same way.</p>
          <p><strong>Or let your own coding agent do it.</strong> On L2, add the Entoli MCP server to Claude Code or Cursor (dashboard, Keys tab). Entoli tells your agent what to wire and keeps it inside the lines: it can only touch the files an integration needs, only wire acts you exposed, and never weaken a contract. Everything it writes comes back as a diff you approve; nothing reaches your repository except the pull request.</p>
          <p><strong>Or don't write it yourself.</strong> On L1, download the skill for Claude Code, Cursor or AGENTS.md (Skill tab) and ask your agent to integrate it. On L2, connect GitHub and speak to the dashboard: “integrate new note and search, by voice”, “approve all”, “open the pull request”.</p>
        </li>
      </ol>
      <h2>Check it</h2>
      <pre tabIndex={0}>{`npx entoli-test entoli.skill.json https://my-preview.vercel.app --min 90`}</pre>
      <p>A real browser walks the map and reports coverage and anything broken. The same report appears in the dashboard.</p>
      <h2>Try it first</h2>
      <p>The <code>examples/notes-app</code> demo (Fieldnotes) is fully wired: new note, search, tag, delete, theme, font size, and an email change that is voice only and shows exactly what will run.</p>
    </Page>
  );
}
