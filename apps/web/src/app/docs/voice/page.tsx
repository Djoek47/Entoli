import { DocsNav, Page } from '@/components/Page';
import { PLANS } from '@/lib/plans';

export const metadata = { title: 'Integrate by voice' };

export default function IntegrateByVoice() {
  const l2 = PLANS.l2;
  return (
    <Page>
      <div className="kicker" style={{ marginTop: 24 }}>Docs</div>
      <h1>Integrate by voice</h1>
      <DocsNav at="/docs/voice" />
      <p>The dashboard is itself an Entoli app. On the L2 plan you can talk to it, or type to it, and it does the work through the same declared acts, guardrails and yes-before-it-changes-anything contract your own app will have.</p>

      <h2>1. Start</h2>
      <ul>
        <li><strong>Connect a repository</strong> (read-only) and press Analyze, or</li>
        <li><strong>Start from empty</strong>: describe the app and pick plain HTML, Vite + React or Next.js. Entoli writes the skill first (screens, features, honest “no” answers) and a small starter that already runs. Say “start a new project” to do it by voice. Or</li>
        <li><strong>Copy an existing app and rebuild it</strong>: the original stays untouched and keeps running beside the new one, judged by the same map and phrases. For an app inside a monorepo, give <code>owner/name#apps/web</code>. (Apps that depend on packages elsewhere in their monorepo cannot run in a sandbox.)</li>
      </ul>

      <h2>2. Talk it through</h2>
      <p>Turn on <strong>live voice</strong> (the orb) for an open conversation, or keep typing one instruction at a time. Say “what should I expose?” and Entoli proposes, per feature, <strong>Layer 2</strong> (the AI answers: one sentence replaces several clicks), <strong>Layer 1</strong> (the device answers: short, no AI, no cost) or <strong>manual</strong> (reaches outside the app, or cannot be undone), with a reason for each. Ask “why is change email manual?”, then “accept the proposal”. It asks for a yes because it changes what the AI can reach, and you can undo it.</p>

      <h2>3. Your agent does the heavy lifting</h2>
      <p>Entoli does not write your code. Add the Entoli MCP server to Claude Code or Cursor (Keys tab). Entoli is the orchestrator, the guardrail and the voice: it tells your agent what to wire, refuses anything outside the lines, and tells you out loud what your agent did (“Your agent submitted a change to src/App.tsx. It is waiting for your approval.”).</p>
      <ul>
        <li>Your agent can only touch the files an integration needs (in a new project: ordinary source files, never <code>.env</code>, git data or <code>node_modules</code>, and no install-time scripts).</li>
        <li>It can only wire acts you exposed, and never weaken a contract.</li>
        <li>Every change is a diff you approve, one by one. For a repository, they become one pull request; for a new project, they are written into the project and you download it as a zip.</li>
      </ul>

      <h2>4. Try it before you approve</h2>
      <p>The test sandbox runs your app in an isolated, disposable window with the Entoli layer applied, including changes still waiting for your yes. The checks walk your map and type every feature’s phrase into the real bar. Entoli can also read your design (Design tab) so its bar and cards look like your app.</p>

      <h2>Limits and privacy</h2>
      <ul>
        <li>{l2.liveMinutes} live-voice minutes and {l2.voiceToolTurns} dashboard instructions a month on L2. One live session lasts up to 10 minutes and turns itself off after 3 quiet minutes. Typing never runs out.</li>
        <li>The microphone is on only while the orb says so; mute is always one click.</li>
        <li>Audio goes from your browser to the voice provider with a key that expires in two minutes. We do not record or store audio.</li>
        <li>Read the full <a href="/privacy">privacy policy</a> and the <a href="/docs/safety">safety model</a>.</li>
      </ul>
    </Page>
  );
}
