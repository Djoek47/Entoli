import { DocsNav, Page } from '@/components/Page';

export const metadata = { title: 'Skill format' };

export default function SkillFormat() {
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Docs</div>
      <h1>entoli.skill.json</h1>
      <DocsNav at="/docs/skill" />
      <p>The skill is the contract between your app and Entoli. The SDK validates it on <code>mount()</code> and refuses an invalid one; the dashboard only saves valid ones.</p>
      <pre>{`{
  "entoli": "0.1",
  "app": { "name": "Fieldnotes" },
  "layer": "L1",                       // default for every act: L1 the device answers · L2 Entoli AI answers
  "mode": "voice",                     // text · voice
  "map": [                             // screens and controls, for the dashboard and the tester
    { "id": "notes", "kind": "screen", "title": "Notes", "path": "/" },
    { "id": "notes.new", "kind": "button", "title": "New note", "parent": "notes",
      "selector": "[data-testid=new-note]", "act": "note.create" }
  ],
  "knowledge": [                       // the only source for "can it …?" answers
    { "topic": "export to PDF", "can": false, "answer": "No. Fieldnotes can't export to PDF yet." }
  ],
  "acts": [
    { "name": "note.create", "title": "New note", "phrases": ["new note", "write down"],
      "radius": "self", "undo": true,
      "slots": { "text": { "type": "freeText", "required": true, "prompt": "What should it say?" } } }
  ]
}`}</pre>
      <h2>Acts</h2>
      <table><thead><tr><th>Field</th><th>Meaning</th></tr></thead><tbody>
        <tr><td><code>name</code></td><td>Unique, starts with a lowercase letter (<code>note.create</code>).</td></tr>
        <tr><td><code>phrases</code></td><td>How people ask, matched on the device.</td></tr>
        <tr><td><code>radius</code></td><td><code>self</code> (only this user), <code>other-person</code>, <code>external</code> (outside the app or account).</td></tr>
        <tr><td><code>undo</code></td><td>The app can take it back. Without an undo function in code, it never runs on silence.</td></tr>
        <tr><td><code>exact</code></td><td>Show every argument; the yes is bound to exactly what was shown.</td></tr>
        <tr><td><code>voiceOnly</code></td><td>Typed requests are refused.</td></tr>
        <tr><td><code>kind</code></td><td><code>setting</code> acts always need a yes.</td></tr>
        <tr><td><code>layer</code></td><td><code>L2</code> Entoli AI may answer and pick it, <code>L1</code> device only, <code>off</code> not connected. Overrides the app's layer.</td></tr>
      </tbody></table>
      <h2>Slot types (closed set)</h2>
      <table><tbody>
        <tr><td><code>choice</code></td><td>One of <code>options</code> (strings or <code>{'{ value, label, aliases }'}</code>), or options supplied at runtime.</td></tr>
        <tr><td><code>quantity</code></td><td>A number, as people say it (“twelve fifty”, “a hundred and twenty”). Arrives as <code>{'{ n, label }'}</code>.</td></tr>
        <tr><td><code>when</code></td><td>A date or time (“tomorrow”, “Friday at 9”). Arrives as <code>{'{ at, label }'}</code>.</td></tr>
        <tr><td><code>person</code></td><td>Someone from <code>options</code>.</td></tr>
        <tr><td><code>freeText</code></td><td>The rest of the sentence.</td></tr>
      </tbody></table>
      <p>A JSON Schema for editors is exported as <code>skillJsonSchema</code> from <code>@entoli/sdk/skill</code>.</p>
    </Page>
  );
}
