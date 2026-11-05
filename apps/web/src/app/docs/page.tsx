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
          <h3>Get a skill</h3>
          <p>Connect your repository in the <a href="/dashboard">dashboard</a> and press Analyze, or run the analyzer locally. You get <code>entoli.skill.json</code>: the map of your screens, the acts your app can do (each with its blast radius and whether it can be undone) and what it can and can't do. Review it; nothing is published until you say so.</p>
          <pre>{`npx entoli analyze ./my-app          # static scan; with ANTHROPIC_API_KEY, Claude reviews the draft`}</pre>
        </li>
        <li>
          <h3>Mount the bar</h3>
          <pre>{`npm i @entoli/sdk

import { mount } from '@entoli/sdk';
import skill from './entoli.skill.json';

mount({ el: '#entoli', skill, mode: 'voice', key: import.meta.env.VITE_ENTOLI_KEY });`}</pre>
          <p>The key is optional and public (it ships in your front end). Without it every phrase resolves on the device; with it, unclear phrases go to Entoli, which may only choose among your declared acts.</p>
        </li>
        <li>
          <h3>Wire each act to the function that already does it</h3>
          <pre>{`import { useEntoli } from '@entoli/sdk/react';

useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), {
  undo: (note) => removeNote(note.id),          // with undo, small things run after a 1.6 s hold
});

useEntoli('settings.email', { email: 'freeText' }, ({ email }) => changeEmail(String(email)), {
  radius: 'external', exact: true, voiceOnly: true, // shows exactly the address; the yes covers only it
});`}</pre>
          <p>Plain JavaScript: <code>defineAct(name, slots, handler, options)</code> works the same way. On paid plans, the guided integration prepares these changes for you as a pull request you approve change by change.</p>
        </li>
      </ol>
      <h2>Check it</h2>
      <pre>{`npx entoli-test entoli.skill.json https://my-preview.vercel.app --min 90`}</pre>
      <p>A real browser walks the map and reports coverage and anything broken. The same report appears in the dashboard.</p>
      <h2>Try it first</h2>
      <p>The <code>examples/notes-app</code> demo (Fieldnotes) is fully wired: new note, search, tag, delete, theme, font size, and an email change that is voice only and shows exactly what will run.</p>
    </Page>
  );
}
