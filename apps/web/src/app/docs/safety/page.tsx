import { DocsNav, Page } from '@/components/Page';

export const metadata = { title: 'Safety model' };

export default function Safety() {
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Docs</div>
      <h1>The safety model</h1>
      <DocsNav at="/docs/safety" />
      <h2>AI chooses; it never invents</h2>
      <p>At runtime the model only picks among acts your skill declares and your code has wired. The act name and slot names are constrained by the response schema and checked again on the server and in the SDK. A choice the model makes always waits for an explicit yes.</p>
      <h2>The commit contract</h2>
      <table><thead><tr><th>Act</th><th>What happens</th></tr></thead><tbody>
        <tr><td><code>self</code> + undo</td><td>Runs after a 1.6 s visible hold, with “Not that”. Then a receipt with Undo.</td></tr>
        <tr><td>no undo, <code>other-person</code>, settings</td><td>Waits for an explicit yes.</td></tr>
        <tr><td><code>external</code> or <code>exact</code></td><td>“Do exactly this”: every argument is listed; the yes is bound to a fingerprint of that card. If anything changed, nothing runs.</td></tr>
        <tr><td><code>voiceOnly</code>, typed</td><td>Refused, with the reason.</td></tr>
      </tbody></table>
      <p>Your skill and your code are merged stricter-wins: the larger radius, and undo only when an undo function exists. <code>mount({'{'} confirm: 'always' {'}'})</code> makes every act wait for a yes.</p>
      <h2>Knowledge</h2>
      <p>“Can it …?” is answered only from the skill's knowledge list. Anything not there gets “I don't know”.</p>
      <h2>Where things run</h2>
      <p>Most phrases resolve on the device, with no network. Only unclear phrases (and, for metering, voice turns) reach Entoli with your public app key, which can spend that app's intents and nothing else. You can restrict it to your origins in the dashboard.</p>
      <h2>Your code</h2>
      <p>Repositories are read through a read-only GitHub App installation, downloaded once per analysis and deleted afterwards; only source files are extracted. Write access is requested only to open the guided-integration pull request, and only changes you approved go into it.</p>
    </Page>
  );
}
