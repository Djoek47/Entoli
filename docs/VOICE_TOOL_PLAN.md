# The voice tool: plan to finish

The voice tool is Entoli operating on itself. A developer on the L2 plan talks to the dashboard; Entoli connects their code, finds what the app can expose, has *their own coding agent* wire it in, shows the result in a test sandbox, and matches their design system.

## Decisions (from the owner)

| Question | Decision |
|---|---|
| Voice provider | Entoli provides it, L2 only. OpenAI Realtime first; ElevenLabs behind the same interface later. |
| Always-on | A toggle (an orb, like ChoreMaxx). Typing and one-at-a-time instructions stay the default; live voice is optional and metered (`VOICE_LIVE_MINUTES`, default 120 a month). |
| Who writes the code | **The developer's own agent**, connected over MCP. Entoli does not do the heavy lifting: it is an orchestrator, a guardrail and a communication layer (instructions in, reports out, limits on what the agent may touch). |
| Built around Entoli from scratch | Entoli's agent is "powered" by the developer's own agent: Entoli supplies instructions, their agent writes. |
| Sandbox | Vercel Sandbox (or any cheap equivalent behind one interface). |
| Blank start | Two ways: (a) start empty, built on Entoli from the first line; (b) copy an existing app, then rebuild it on Entoli. Either way the original is kept to learn from and to compare against. |
| The realtime model | Ears and mouth only. It transcribes and speaks what Entoli tells it. Every decision stays in Entoli's contract (hold, yes, "Do exactly this" bound to a fingerprint). |

## Steps

Each step ends with tests green, a commit, and a `STATUS.md` entry. Nothing starts before the one above works.

### 1. Always-on voice conversation (in progress)
- `LiveProvider` interface in the SDK; `startLive(entoli, provider)` bridges transcripts into `entoli.hear`, speaks what Entoli answers, handles barge-in (the user talks, speech stops), mute, and speaks outcomes that arrive later (a held action completing).
- Providers: OpenAI Realtime over WebRTC (ephemeral key minted by our server, never the real key); browser continuous recognition as the no-account fallback.
- Server: `POST /api/voice/session` (L2 only, quota check, mints the ephemeral key), `POST /api/voice/heartbeat` (meters live seconds, tells the client when the quota is out).
- Orb UI in the dashboard dock: idle, listening, thinking, speaking, muted; one click to turn on or off.
- Done when: a spoken "go to the map tab" moves the dashboard, a spoken "open the pull request" shows the exact card and a spoken "yes" confirms it, talking over the reply stops it, mute stops all listening, and the quota ends the session.

### 2. Entoli MCP server: the orchestrator and guardrail layer
- A remote MCP server (`/api/mcp`, per-app token) the developer adds to Claude Code, Cursor or any MCP client.
- Tools it gives their agent: `get_skill`, `get_instructions` (how to wire each act, in their stack), `get_design_tokens`, `list_acts_to_wire`, `report_progress`, `submit_change` (a diff for human approval).
- Guardrails it enforces: the agent may only touch files in the approved list (the act's source files, the entry, the theme, `package.json`), only wire acts the developer exposed, never declare weaker radius/undo than the skill; every change returns as a diff into the existing approve-one-by-one flow. Nothing reaches the repository except through the pull request.
- The live conversation can say what the agent is doing ("your agent has wired search; approve it?") because the agent reports through this server.
- Done when: a real MCP client (the SDK's test client) connects with a token, is refused out-of-scope files, and its submitted diffs appear in the Guided integration tab.

### 3. Test sandbox windows
- Boot the developer's app in a Vercel Sandbox with the changes applied and the Entoli bar mounted; show it in the dashboard in an iframe (the "testable windows"), one per exposed feature or screen.
- The tester walks the map there automatically and reports what works, what suggests the wrong thing, what does nothing; results are spoken and listed.
- Apps that need a database or secrets run with mocks or "partially runs" is stated plainly.
- Done when: apply changes → sandbox boots → the window answers a typed and a spoken phrase → coverage appears in the Test tab, without leaving the dashboard.

### 4. Design-system extractor
- Read tokens from the code (CSS variables, Tailwind config, theme files, font imports), screenshot the running app (sandbox) and sample real computed styles; produce one token set (colours, fonts, radius, spacing, shadows).
- Apply it to the Entoli bar and card (`entoli.theme.css`, already generated for the Next/Vite bootstraps), preview it in the sandbox windows, adjustable by voice ("rounder", "use our blue").
- Done when: on three fixture apps (plain CSS variables, Tailwind, CSS-in-JS) the extracted tokens match the app and the bar visibly matches in a screenshot comparison.

### 5. What to expose: the proposal conversation
- After reading the app, Entoli proposes what to put on the Entoli layer ("these five features would be simpler by voice; these two should stay manual"), says why, and sets layers (L1 / L2 / off) as the developer agrees. Uses the analyzer, the map and Claude; already half there.
- Done when: the conversation produces the skill with per-act layers set, spoken start to finish.

### 6. Blank start and copy-and-rebuild
- Start from empty: the developer describes the app; Entoli writes the skill first (acts, knowledge, screens) and gives their agent the instructions to build the app around it.
- Copy an existing app: import the repo as the original, build a new project around Entoli, and compare the two (the tester runs the same map on both).
- The original is always kept and shown beside the new one.
- Done when: both routes produce a running app in the sandbox that passes the map walk.

### 7. Launch pass for the voice tool
- Cost controls (live minutes, per-session cap, idle timeout), abuse limits, a visible "listening" indicator and mute, privacy copy (audio is not stored by us), pricing page updated with the real live-minutes number, docs page "Integrate by voice", and a recorded end-to-end demo run.

## Accounts and keys the voice tool needs
- `OPENAI_API_KEY` (Realtime), or `ELEVENLABS_API_KEY` once that provider is built.
- `VOICE_PROVIDER` (`openai` default), `VOICE_LIVE_MINUTES` (default 120), `VOICE_TOOL_TURNS` (default 300).
- Vercel Sandbox access (step 3).
- An MCP client to test with: Claude Code or Cursor (step 2).

## Risks, stated up front
- The OpenAI Realtime calls are written from the documented API and cannot be run here without a key; the first live run will need small fixes.
- Live-seconds metering is reported by the browser; until sessions are bounded by the provider's own limits, a modified client could under-report. Mitigation: short-lived keys, a hard per-session cap, and provider-side spend limits.
- A sandbox cannot always run a developer's full app (databases, secrets, private services). The plan treats that as a stated limit, not a hidden failure.
