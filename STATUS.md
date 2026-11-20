# Entoli status

Each milestone: what is real, what is stubbed, how to run it.

## M1 — `@entoli/sdk` (packages/sdk) — done

**Real**
- `mount({ el, skill, key, mode })`: validates the skill, draws the command bar and the one-card Stage, sets the instance hooks use.
- `useEntoli(name, slots, handler, { undo, voiceOnly, exact, radius })` (`@entoli/sdk/react`), `useStage()`; `defineAct()` for plain JS (works before or after mount).
- On-device resolution: tacit's tier-0 matcher, ported, not rewritten (`src/engine/`: `local.ts`, `route.ts`, `text.ts`, `mood.ts`, `numbers.ts`, `grammar.ts`, `free.ts`, core `types.ts`). Slot types map to tacit primitives: choice/person → option matching, quantity → number grammar, when → date grammar, freeText → remainder.
- Commit contract (`src/contract.ts`): self + undo → 1.6 s visible hold with "Not that"; settings, other-person, no-undo and model-read acts → explicit yes; external or `exact` → "Do exactly this" with every argument, yes bound to a fingerprint of the card (a stale or foreign fingerprint runs nothing); voiceOnly typed → refused. Skill and code are merged stricter-wins; undo only counts when an undo function exists.
- Receipts with Undo; spoken/typed "yes"/"no" answer the card on stage; missing required slots are asked for.
- Knowledge answers only from `skill.knowledge`; otherwise "I don't know".
- Skill schema + validator (`src/skill.ts`): closed slot types `choice | quantity | when | person | freeText`, radius `self | other-person | external`, layers L1/L2, setting acts require L2. JSON Schema exported for editors.
- Voice: Web Speech API behind a `SpeechProvider` interface (swap in a paid STT/TTS later).
- Builds: ESM + `.d.ts` (`dist/`), plus `dist/entoli.min.js` (IIFE, global `Entoli`). 45 kB min / 17 kB gzip; build fails over 30 kB gzip.

**Stubbed / later**
- Model fallback calls `POST {endpoint}/api/intent` with the app key; the endpoint is built in M5. Without a key everything is on device.
- Voice-turn metering is done server-side in M5; the SDK does not beacon on its own yet.
- Not ported from tacit: Jev tier, outbox/deferred effects, attention gate, menus, eui custom element. The Stage is a smaller DOM renderer following eui's rules (one card, their words above, a way out on every card).

**Run**
```bash
pnpm install
pnpm --filter @entoli/sdk test
pnpm --filter @entoli/sdk build
```

## M2 — `examples/notes-app` (Fieldnotes demo) — done

**Real**
- Vite + React app: Notes (new, search, tag, delete) and Settings (theme, font size, email), persisted in localStorage, with ordinary buttons too.
- Every act in `examples/notes-app/entoli.skill.json` is wired with `useEntoli` to the app's real functions, with undo where the app can take it back.
- Contract in action: new note / search / tag / delete / navigate hold 1.6 s with "Not that"; theme and font size are settings and wait for a yes; font size is range-checked before the card; email is external + exact + voice only: typed is refused, spoken shows exactly the normalised address ("ana at example dot com" → `ana@example.com`) and the yes is bound to that card.
- Knowledge questions answered from the skill only ("can it export to PDF?" → no).
- 8 end-to-end tests (real App + real SDK in jsdom); checked in Chromium (desktop + 390 px), no console errors.
- SDK addition: `prepare` option on acts, so a card always shows what will run.

**Stubbed / later**
- Model fallback is off unless `VITE_ENTOLI_KEY` (and optionally `VITE_ENTOLI_ENDPOINT`) is set; needs M5.
- Voice uses the browser's Web Speech API (Chrome/Edge/Safari); Firefox gets text only.

**Run / deploy**
```bash
pnpm --filter @entoli/example-notes dev
pnpm --filter @entoli/example-notes test
```
Vercel: new project, Root Directory `examples/notes-app`, framework Vite (its `vercel.json` sets the rest). The SDK is compiled from source via a Vite alias, so no separate build step.

## M3 — `apps/web` (Next.js 16, App Router) — done

**Real**
- `/` is the original marketing page, served byte-for-byte from `site/index.html` except the "Ask Entoli" bar, which now runs on `@entoli/sdk` with its own skill (`apps/web/site/site.skill.json`): navigation acts hold 1.6 s, "connect github" is external and shows "Do exactly this", questions answer from the site's knowledge. `scripts/build-site.mjs` does the transform at build time; `site/` stays the source of truth.
- `/login`: GitHub OAuth via Auth.js (read-only identity scopes). JWT sessions; users upserted by GitHub id.
- `/dashboard`: list and create apps (name + repo). Per app: Map (tree + acts table with contract), Knowledge (add/remove), Skill (JSON editor, validated on save, draft/publish, download; publishing L2 requires the L2 plan), Keys (create shown once via the action response, only sha256 stored, revoke), Usage (this month vs plan, estimate, model cost).
- Every data function is owner-scoped; another user's app id 404s.
- Repo connection: GitHub App install link + `/api/github/setup` callback; installation kept only if it can see the repo. App JWT (RS256) and read-only installation tokens are implemented and tested.
- Postgres via Drizzle: Neon HTTP driver in production; PGlite (in-process) for local dev and tests, same migrations (`drizzle/`).
- 8 tests (data layer on real Postgres-in-WASM, GitHub JWT). Browser walkthrough: site bar → exact card → login → create app → paste skill → map → key shown once → invalid skill refused.

**Stubbed / later**
- Tabs Analyze, Billing, Guided integration, Test are placeholders until M4/M6/M7/M8.
- Without `AUTH_GITHUB_ID/SECRET`, dev mode signs you in as a local "dev" user (never in production).

**Run**
```bash
pnpm --filter @entoli/web dev     # http://localhost:3000, no env needed
pnpm --filter @entoli/web test
```
Deploy: Vercel project with Root Directory `apps/web` (Next.js). Set `DATABASE_URL`, `AUTH_*`, `GITHUB_APP_*`, then `pnpm --filter @entoli/web db:migrate` once against the database.

## M4 — Analyzer (`packages/analyzer` + `/api/analyze`) — done

**Real**
- `entoli analyze <path> [--out] [--print] [--no-ai] [--model] [--max-input-tokens]` (`packages/analyzer/bin/entoli.mjs`).
- Static pass with TypeScript's parser (no execution of the repo's code): routes from React Router (`<Route>` and route objects), Next.js app and pages routers (per package in monorepos, route groups dropped, `[id]` → `:id`), Vue Router objects and Nuxt pages; buttons with their handlers (including `x.bind(...)` server actions and `navigate('/x')`), links, forms with typed fields, selects with options, toggles, settings (by place and by word); an import graph assigns each control to the screen that uses it.
- Draft skill: one act per real handler; loose text inputs become slots of the create/submit button next to them; setters named after their field (`theme`, `fontSize`); `nav.open` over the screens; contract guesses (external/other-person/no-undo by words in the code), settings → `kind: setting`, voice only, layer L2. Always validated.
- Claude pass (when `ANTHROPIC_API_KEY` is set): `claude-opus-5-5` (override with `ENTOLI_MODEL`), structured JSON output, server-side refusal fallback, summary capped by `ANALYSIS_MAX_INPUT_TOKENS` (default 60k, the cap is logged), output capped by `ANALYSIS_MAX_OUTPUT_TOKENS` (32k). It cannot add capability: acts must cite control ids from the scan or are dropped; radius/undo/exact/voice-only merge stricter-wins; choice options must exist in the code; the result must validate or the static draft is kept. Tokens and cost are logged per analysis.
- Dashboard: Analyze tab (job runs after the response, page polls), `POST/GET /api/analyze`. Downloads one tarball (codeload for public repos, installation token for private), 80 MB cap, extracts only source files (no symlinks, no node_modules). Result saved as a draft; publishing stays a human step.
- Tests: 15 analyzer (fixtures for React Router, Next app router, Vue, a monorepo, the real Fieldnotes app; merge rules; refusal/truncation; CLI) + 5 web (tarball extraction safety, job success/failure). Live check: this repository analyzed through the dashboard from GitHub (51 files, 9 Next routes, 19 acts).

**Stubbed / not verified here**
- The Claude pass is tested against a stubbed client only: no Anthropic key in this environment, and a live call costs money. First real run will show prompt quality.
- Analysis runs inside the request's `after()` window (max 300 s on Vercel). Very large repos may need a queue later.
- Monorepos are analyzed whole; a per-app subdirectory setting is a later addition.

**Run**
```bash
pnpm --filter @entoli/analyzer build
node packages/analyzer/bin/entoli.mjs analyze examples/notes-app --no-ai --print
ANTHROPIC_API_KEY=... node packages/analyzer/bin/entoli.mjs analyze ./my-app
```

## M5 — Runtime API (`/api/intent`) — done

**Real**
- `POST /api/intent` with `Authorization: Bearer ek_live_…` (CORS enabled; the key is a public client key). Body: what the SDK already sends (`phrase`, `channel`, the wired `acts` with their slot types and runtime options).
- The model only chooses: candidates are acts in the app's **published** skill **and** wired in the calling client; the act name and slot names are `enum`s in the structured-output schema and checked again on return; option slots must match an option; anything else becomes `{ act: null }`. Claude `claude-opus-5-5`, effort low, refusal fallback on. The SDK then applies the commit contract (a model's choice always waits for a yes).
- Metering per app per calendar month (UTC): one text intent per text call, one voice turn per voice call, plus model calls, tokens and cost. Device-resolved voice turns are reported by the SDK (`local`) and metered without a model call.
- Limits before any model call: Developer plan stops at 1,000 text intents (402, on-device matching keeps working); voice needs L1/L2 (402); paid plans get an `x-entoli-warning` header past 80% and overage is billed (M6). Per-key rate limit (default 120/min, `INTENT_RATE_PER_MIN`, Postgres-backed so it holds across instances). Optional allowed origins per app (Keys tab), including `*.vercel.app` wildcards.
- No model configured: answers `{ act: null, reason: 'model unavailable' }` and does not meter.
- SDK: shows the server's error text; reports voice turns resolved on the device.
- Tests: 10 for the handler (keys, origins, publish gate, choose-only, invented acts, runtime options, metering, plan limits, rate limit).

**Limits of v0.1**
- With the browser's Web Speech API, voice metering of device-resolved turns relies on the SDK reporting them; it becomes enforceable once speech runs through a server-side provider.

## M6 — Billing (Stripe) — done (needs your Stripe account to go live)

**Real**
- Billing tab per app: plan cards (Developer $0 / L1 $49 / L2 $299), Stripe Checkout for upgrades, customer portal (invoices, card, cancellation), managed setup request ($2,500 one-time Checkout that opens a request listed in the dashboard).
- One Stripe customer per app (meters aggregate per customer, so two apps never bill against each other).
- Plans change only from verified webhooks (`/api/stripe/webhook`: `checkout.session.completed`, `customer.subscription.created|updated|deleted`); a lapsed or cancelled subscription drops the app to Developer.
- Metered billing with Stripe Billing Meters: hourly cron (`/api/cron/usage`, `vercel.json`) reports voice turns and text overage as deltas since the last report, with idempotent event identifiers; reported counters stored per app per month.
- `scripts/stripe-setup.mjs` creates (idempotently) the two meters, five products and six prices with lookup keys: no price ids in env vars.
- Limits enforced in `/api/intent`: Developer plan hard stop at 1,000 text intents and only one free app per account; voice only on L1/L2; paid plans warned past 80%, overage billed at $2 / 1,000.
- Dev mode without Stripe: a plan switcher on the Billing tab to try the limits.
- Tests: 7 (Checkout parameters, signed webhooks verified with Stripe's own test signatures, plan transitions, managed request paid, usage deltas and idempotency, one free app). Live: the Fieldnotes build calls the local `/api/intent` cross-origin with a real key (OPTIONS 204, POST 200).

**Notes**
- Included intents count by calendar month (UTC); Stripe invoices on the subscription's anniversary. Overage is reported as it happens, so it lands on whichever invoice is open.
- Nothing has been charged or created in a real Stripe account from here.

## M7 — Guided integration (paid) — done (PR step needs the GitHub App)

**Real**
- Guided integration tab, L1/L2 plans only. Interview: features to expose (from the skill), layer, text or voice, design (Entoli's / inherit the app's / generated from the app's CSS variables), who may change settings (anyone / admins / nobody), confirmation (contract / always ask).
- Changes prepared per file and shown as unified diffs: `entoli.skill.json` (only the chosen features; settings dropped on L1 or "nobody"), `@entoli/sdk` dependency, a bootstrap (`src/entoli.ts` for Vite/React, `components/EntoliBar.tsx` for Next.js), the entry import, an optional theme file — all deterministic. Wiring `useEntoli` into existing components is done by Claude, one call per file, using the act locations recorded by the analysis; the result must parse and must actually wire something, or it is not offered.
- Each change is approved, rejected or reset on its own. "Open pull request" commits only approved changes as one commit on `entoli/integration-…` and opens one PR, with a write-scoped installation token requested at that moment. A file that changed on the default branch since it was read is refused, not overwritten.
- SDK: `mount({ confirm: 'always' })` makes every act wait for a yes.
- Tests: 11 (interview parsing, settings policy, paid gate, theme, dependency edit, generation against the real Fieldnotes source, broken model edits refused, no-model path, PR contents, drift refusal, missing write permission). Browser: interview → changes → approve → PR correctly refused without an installation.

**Needs / limits**
- Wiring edits need `ANTHROPIC_API_KEY`; without it only the setup changes are prepared (the notes say so). Not run against a live model here.
- The PR needs the GitHub App with contents + pull requests **write** permissions (the developer approves them when asked).
- The generated code depends on `@entoli/sdk` from npm: publish the package first.
- Monorepos: the entry is chosen from the package that owns the first analyzed file.

## M8 — Tester (`packages/tester`) — done

**Real**
- `walkMap(skill, url, browser)`: opens every screen with a concrete path (must answer < 400 with no uncaught page error), finds every mapped node by its selector on its screen (shared nodes on the first screen). Coverage = verified ÷ checkable; screens with route parameters and nodes without selectors are listed as "not checkable", not counted.
- CLI `entoli-test <skill.json> <url> [--json] [--min 90] [--upload <dashboard> --key <ek_live_…>]`, exit code 2 on broken nodes or low coverage (CI gate).
- Dashboard Test tab: preview URL (production: public https only, no private/loopback/link-local addresses), "Run the walk now" (local Chromium in dev, `BROWSER_WS_ENDPOINT` for a hosted browser in production), runs list with coverage, broken paths and reasons. `POST /api/test-runs` takes CI uploads with the app key (validated, rate-limited).
- Tests: real Chromium against a static site with known present/missing/erroring/404 pages, and the Fieldnotes build against its own skill (100%, nothing broken); URL guard; report validation. Live: dashboard run on Fieldnotes → 100%, 10/10.

**Needs**
- On Vercel there is no local browser: set `BROWSER_WS_ENDPOINT` (e.g. a hosted Chromium service) or use the CI upload.
- Pages behind a login are walked as an anonymous visitor.

## M9 — Launch polish — done

**Real**
- Public pages: `/docs` (quickstart in 3 steps), `/docs/skill` (format), `/docs/safety` (safety model), `/pricing`; `/terms` and `/privacy` as clearly marked drafts for counsel.
- 404 and error pages; empty states across the dashboard.
- Rate limits: intent API per key, analyses (10/h per user), integrations (6/h), CI report uploads (30/h per app).
- Analytics: Vercel Web Analytics (cookie-less) on the dashboard and the marketing page.
- Build fix: the web build now runs its site/SDK/analyzer/tester step explicitly (pnpm does not run `prebuild` hooks), so Vercel builds what was tested.
- `README.md`: what Entoli is, 3-step integration, repository layout, local run, deploy.
- Production build clean (no warnings); 107 tests across 5 packages.

## Product model update — layers per feature, two plans, the voice tool — done

**What changed (from the owner's brief)**
- **Layer 1** = no AI: typed or spoken (transcribed) requests are matched on the device and the menu responds. **Layer 2** = Entoli's AI answers (spoken back in voice mode), then the change goes on the card under the same contract. The layer is chosen **per act**: `"layer": "L1" | "L2" | "off"` in the skill (overrides the app's), set in the Map tab or by voice. The AI is only ever offered L2 acts; L1 acts it never sees; `off` acts are never matched. Settings are no longer tied to a layer (they always need a yes).
- **Plans**: Developer $0 (1 app, L1, text). **L1 $49 = the skill**: analyzer, map, SDK, tester, voice input as transcription, export to coding agents, bring your own AI (`resolver`). No Entoli AI, nothing metered, one flat Stripe price. **L2 $299 = skill + integration**: Entoli AI at runtime (100,000 intents, $0.015 per AI voice turn, $2 per 1,000 over), the voice tool (300 turns a month, `VOICE_TOOL_TURNS`), and the integration pull request.
- **Voice tool**: every app page in the dashboard has an Entoli bar running on the dashboard's own skill (go to a tab, analyze, prepare the integration with answers, approve/reject/approve all, set a feature's layer, publish, open the pull request). L2 apps: Layer 2, AI via `/api/studio/intent`, metered against the quota. Other plans: the same bar as Layer 1 (device only).
- **Skill export for coding agents** (L1 and L2): Skill tab downloads a Claude Code skill (`.claude/skills/entoli/SKILL.md`), a Cursor rule or an AGENTS.md section, carrying the skill, where each act lives in the code, and how to wire it.
- SDK: `layer` option; L2 asks the AI for every new request with the device's match as a hint; if the AI agrees with the device the small reversible act still runs after the hold, otherwise it waits for a yes; replies shown above the card and spoken; yes/no stay on the device; AI unreachable → device fallback. L1 never calls Entoli with an app key; `resolver` = bring your own AI. Voice-turn beacon removed (AI turns are metered on the server).
- Marketing page, pricing page, docs and README updated to the new model.
- Tests: SDK 45, web 55. Live: the dashboard driven by its own bar (navigate with hold and Undo, approve all, exact "Open the pull request" card).

**Not verified here**: the AI replies (no model key in this environment; the L2 path ran on its device fallback, and the AI path is covered by tests with a stand-in model).

## Voice tool, step 1 — always-on voice conversation — done (provider not run live)

Plan for the whole voice tool: `docs/VOICE_TOOL_PLAN.md` (7 steps, decisions recorded, acceptance test per step). Step 1 is built.

**Real**
- SDK: `startLive(entoli, provider)` bridges spoken transcripts into `entoli.hear`, so the commit contract is unchanged: a spoken "yes" confirms the "Do exactly this" card that was just read out, a held action's outcome is spoken when it lands, talking over the reply interrupts it, mute stops listening and speaking, idle (5 min) and session (30 min) caps. `spokenFor` decides what each card sounds like.
- Providers: `openaiRealtime` (WebRTC, short-lived key; the model is created with auto-replies off, so it only says what Entoli tells it) and `browserLive` (continuous browser recognition, no account).
- Server: `POST /api/voice/session` (L2 only, owner only, monthly live minutes `VOICE_LIVE_MINUTES` default 120, mints the short-lived key; the real key never reaches the browser), `POST /api/voice/heartbeat` (meters live seconds, a single claim capped, rate-limited, tells the client to stop at zero). Usage tab shows live minutes.
- Dashboard: an orb in the dock (off / connecting / listening / speaking / muted), one click on, one click off, a real mute, minutes left. Off by default: typing and one-at-a-time instructions stay the normal way.
- Tests: SDK 57, web 62 (+ the earlier suites). Browser: the orb loads, the session route answers, and with no provider key it falls back to browser recognition and says so.

**Not verified**: the OpenAI Realtime calls (client secret, WebRTC `/v1/realtime/calls`, event names) follow the documented API but were never run here (no key). Expect small fixes on the first live run. ElevenLabs is not built; the interface is ready for it.

## Voice tool, step 2 — Entoli MCP server (orchestrator and guardrail) — done

**Real**
- `POST /api/mcp`: a remote MCP server (Streamable HTTP, stateless, JSON), per-app tokens (`em_…`, hashed, shown once, revocable; Keys tab shows copy-paste setup for Claude Code and Cursor). L2 plan only; rate-limited.
- Seven tools for the developer's own agent: `get_skill`, `get_guardrails`, `list_acts_to_wire`, `get_instructions` (exact wiring per act), `report_progress`, `submit_change`, `get_change_status`. The server also sends orchestration guidance in the MCP `instructions` field.
- Guardrails (`lib/guardrails.ts`, pure and tested): (1) only files an integration needs: the exposed acts' source files, the entry, the skill, package.json, bootstrap/theme files, no `..`/absolute/`.env`/workflows; (2) only acts in the skill and never an "off" one; (3) never a weaker contract: radius, exact, voiceOnly, undo, setting kind, and the skill file may only tighten and never add acts or give the AI more reach; options must be literals so they can be checked; (4) package.json may only gain `@entoli/sdk`.
- The agent cannot write to the repository. `submit_change` stores a pending diff (against the live file on GitHub) in the same Guided integration list, approved one by one, then one pull request; a revised submission replaces the earlier one; refusals are logged and shown with reasons.
- Dashboard: agent tokens in Keys; "Your coding agent" activity feed in Guided integration.
- Tests: 17 guardrail tests, and 6 with the **official MCP client** over real HTTP (handshake, tools, full submit/approve loop, 7 refusal cases, revision, auth, JSON-RPC edge cases). Also checked against the running Next server with a real client.

**Not verified**: with Claude Code or Cursor themselves (tested with the official SDK client, which they use). Base-file reads use the GitHub contents API (installation token for private repos): the live path is untested here.

## Voice tool, step 3 — test sandbox windows — done (Vercel path not run live)

**Real**
- `Test sandbox` tab (L2): boots the developer's app in an isolated sandbox with the Entoli layer applied, shows it in live windows (one iframe per screen), and keeps the log, what was applied, and the checks. Start / restart / stop; one live sandbox per app; 30-minute life; rate-limited.
- **Judge before approving**: the integration's changes that are *not rejected* are overlaid, approved and still-pending alike, and marked "waiting for you" in the tab. Rejected changes never run.
- Providers behind one interface: **Vercel Sandbox** (`@vercel/sandbox` v4, production default) and a **local** sandbox (dev and tests only: it refuses to start in production because it would run developers' code on our machine). Stopping kills the whole process tree (found by a test: `npm run dev` had left an orphan server).
- Stack detection: npm / pnpm / yarn, Vite / Next / plain Node; plainly says why when it cannot (no package.json at the root, no dev/start script, too large). No secrets or env from the developer's project are copied in.
- Checks (`packages/tester`): the map walk, plus **phrase checks**: each connected act's phrase is typed into the app's real bar and the card is read: understood / ran and then undone (safe held acts only) / not understood / wrong act / failed / not checked (no bar yet). Anything that needs a yes is never confirmed. Results are shown as a table with reasons, stored, and the walk also lands in the Test tab.
- Voice-tool acts: "start the sandbox", "run the checks"; "go to the sandbox".
- Tests: sandbox end to end with a real fixture app, real `npm install`, real dev server and real Chromium (overlay of approved/pending/rejected, 100% walk, 2 of 3 acts good with the unwired one caught, bar-missing path, failure path, stop really stops, production refusal, path escape); phrase checks on the real Fieldnotes build; stack detection. Dashboard checked against a real GitHub download.

**Not verified here**: the Vercel Sandbox provider (written against the v4 types; no credentials here), and apps that need a database or secrets (they run only as far as they can; the log says where they stop). Monorepo sub-apps (no root package.json) are not started yet: a later addition.

## Voice tool, step 4 — design-system extractor — done

**Real**
- New package `@entoli/design`: colour maths (hex/rgb/hsl/shadcn triples, WCAG contrast), **static** extraction, **runtime** sampling, merge, tweak, theme generation.
- Static: CSS/SCSS custom properties in `:root` and in dark selectors (`.dark`, `[data-theme=dark]`, `prefers-color-scheme`), body declarations, radii on cards/buttons, `@font-face`; Tailwind config (colours incl. `hsl(var(--x))`, fontFamily, borderRadius); theme objects (MUI `createTheme` palette/typography/shape, Chakra `extendTheme`, any `colors`/`fonts`/`radii`); styled-components/emotion global styles; Google Fonts links. Each value records where it came from.
- Runtime: computed styles from the real running page (page and text colours, the first vivid filled button as the accent, secondary text, input/card borders, heading/code fonts, median radius, card shadow). The running app wins over the code for what people see; the code is the only source for dark mode.
- Colours the app does not define are derived from the ones it does (a dark app gets a dark card and readable muted text); translucent colours are blended over the background of their own mode (a bug found by looking at this repo's own dark mode).
- The SDK now exposes theme variables (`--e-font`, `--e-font-display`, `--e-font-mono`, `--e-radius`, `--e-on-accent`, `--e-shadow-exact` plus the colour ones) with zero-specificity defaults, so a theme wins whatever order stylesheets load in (a bug the browser test caught).
- Proof in a real browser: sampled from a styled page, the **real Entoli bar and card** take the app's background, radius, ink, heading font, accent, readable button text and hard shadow.
- Dashboard **Design** tab (L2): extract from the repo, look at the running app/sandbox, live light and dark previews drawn by the real stylesheet, a table of every token and where it came from, adjust in plain words ("rounder", "no shadow", "make the accent blue", "use #2563eb as the accent"), undo all. Tweaks are replayed on top, so re-extracting keeps them. Voice acts: "match my design", "make it rounder".
- Used downstream: the integration's `entoli.theme.css` follows the extracted design (unless the developer picked Entoli's own look), and the MCP server gives the developer's agent `get_design_tokens` (tokens plus ready theme CSS).
- Tests: 13 in the package (3 kinds of app, colour, merge/derive/tweak/theme, real-Chromium sampling and themed bar) and 5 in the web app.

**Not done on purpose**: no screenshot-diff image comparison (computed-style assertions on the real page are stricter and not flaky); font files are not downloaded (the stack is kept, and Google Fonts are loaded by the app itself).

## Voice tool, step 5 — the proposal conversation — done

**Real**
- "What should Entoli take over?": every act gets a recommendation with a reason in plain words. **L2** (the AI answers): several details, free text, a time or a person, and undoable: one sentence replaces several clicks. **L1** (the device answers): short, predictable acts, no AI, no cost. **Manual (off)**: reaches outside the app, or cannot be undone and looks destructive (pay, delete, publish, passwords); an act that affects another person is helped by the AI but always asks. Deterministic (same skill, same proposal), so the reasons are checkable and nothing can invent an act.
- Spoken as a conversation: "I found 8 features. I would hand New note, Search notes and Change font size to the AI… I would keep Tag note, Delete note, Go to and 1 more on the device… And I would leave Change email manual… Say accept to apply it, or ask why." Then **"why is change email manual?"** explains, **"accept the proposal"** asks for a yes (it changes what the AI can reach) and applies per-act layers to the skill, and it is **undoable** (the previous layers are restored exactly).
- Map tab: a "What should Entoli take over?" card (grouped, reasons, Accept / Undo); the layer table below stays editable.
- **Announcements**: while the live conversation is on, the dashboard polls what the developer's own coding agent did (`/api/studio/events`) and says it: "Your agent wired search. Your agent submitted a change to src/App.tsx: Wire new note. It is waiting for your approval." / blocked / "The guardrails stopped your agent…". Quiet about "started".
- SDK additions: `say` on an act (what is said when it finishes, instead of "Done: …"), `LiveSession.say()` for unprompted speech, and `readOnly` acts (run at once: nothing to veto or undo; never loosens settings, external, exact, voice-only or AI-picked acts). The dashboard's own acts now suggest the next step when they finish ("When it is done, ask me what to expose.").
- Found by the acceptance test: the proposal answered "Say yes to go ahead" because the contract only let undoable acts run without a yes (→ `readOnly`); stale layer dropdowns after accepting (→ keyed forms); an awkward spoken list.
- Tests: 13 on the engine/announcements/skill hygiene (including "no two dashboard acts share a trigger phrase"), 2 on the full spoken flow (real runtime, real dashboard skill, real live session with a fake voice, real database: propose → why → accept needs yes → yes → layers set; and "no" changes nothing), 3 on `readOnly`, 2 on `say`, 1 on announcements. Real dashboard checked: propose, accept, undo.

**Not done**: no Claude pass over the proposal (the analyzer's model review already judges radius and undo; a second opinion here would make the reasons uncheckable). The spoken conversation has only been run with a fake voice provider and the typed bar; with a real realtime key it is unverified (as step 1).

## Voice tool, step 6 — blank start and copy-and-rebuild — done

**Real**
- **From empty**: describe the app → Entoli writes the skill first (screens, acts, knowledge; the model drafts it, validated, one retry, else an honest empty skill) → a dependency-free starter (server, page, SDK bundle, skill) whose bar is mounted and whose acts are placeholders → the developer's own agent builds the rest over MCP. Without a model key it starts with one empty screen and says so (no invented skill).
- **Copy and rebuild**: the original repo stays untouched in `apps.repo`; a copy of its text source (no `.env`, no `node_modules`, size-capped) becomes the project. Two sandboxes per app by role (`new`, `original`) run side by side; the same map walk and phrase checks run on both and `compare` says which reaches more.
- Files live in the database (`project_files`, migration 0010), not in any repository, until exported as a **zip**. Approving an agent's change writes the file into the project (no PR: there is no repository).
- **Guardrails in project mode**: any normal source path, never `.env*`, `.git`, `node_modules`; `package.json` may not have install/prepare scripts; the contract rules on act code and the tighten-only skill rule are unchanged.
- Dashboard: "Build a new app on Entoli" form, a **Project** tab (files, run new/original, side-by-side results, zip). 5 new projects a day per user.
- Tests (7, real sandbox + real Chromium): the starter passes the map walk and every phrase; rebuild copies only source and both sides run with the same checks; MCP refuses `.env` and `postinstall`, approving writes the file; invalid draft retried then empty; zip matches.

**Not done / not verified**
- The model-drafted skill was only tested with a fake drafter (no key here). Rebuild was tested on a small fixture, not a real GitHub repo; apps needing a database or secrets run only as far as they can without them. Un-approving a change after approval does not remove the file (submit a revision instead). No voice act for "start a project" yet: it starts from the dashboard form.

## Voice tool, step 7 — launch pass — done (the voice-tool plan is complete)

**Real**
- **Cost controls**: one live session is capped at 10 minutes and turns itself off after 3 quiet minutes (server-set, enforced by the SDK's `maxMs`/`idleMs`); a heartbeat can claim at most 70 s; the month's minutes stop the session; sessions are limited per app (20/h) and now per person (40/h across apps).
- **Visible listening + mute**: the orb says "Listening · microphone on" / "Muted · microphone off", mute is one click, off by default.
- **Privacy**: new Voice section (audio goes browser → provider with a 2-minute key; we do not record or store audio; only seconds are metered; projects stored until the app is deleted; zip export); OpenAI added as a sub-processor. Still a **draft for counsel**.
- **Pricing**: the L2 card lists the real live-minutes number and the new "start from empty or rebuild" line (both come from `PLANS`, so they cannot drift).
- **Docs**: `/docs/voice` "Integrate by voice" (start, talk it through, the agent, sandbox, limits, privacy), linked from the docs nav.
- **Recorded run**: `docs/DEMO_RUN.md`, produced by `apps/web/test/demo.test.ts` against the real database, real MCP handler, real sandbox and real Chromium: describe → skill → proposal → why → accept (needs yes) → agent builds, one change refused by the guardrails → announced → approve → sandbox passes (2 of 2 screens, 2 of 2 phrases) → zip.
- Small fix found on the way: the spoken proposal said "they are" for a single feature.
- Tests: web 123 (3 new), whole repo green, typecheck clean, production build clean.

**Not verified (needs your keys/accounts)**: a real OpenAI Realtime conversation, Claude drafting the skill and the proposals' model-side parts, a real coding agent over MCP, the Vercel Sandbox provider, real Stripe, the GitHub App pull-request step, a hosted browser for the checks. The demo run uses fakes for exactly these; it proves the flow and the guardrails, not model quality or audio.

## Hardening week — done

**Real, tested**
- **Gaps closed**: un-approving a change now restores the project file (or deletes one the change created); "start a new project" is a voice act (asks for a yes: it cannot be undone); drafting and copying are limited per day (2 / 3 on the free plan, 10 / 20 once you pay); `.ENV` is blocked as well as `.env`.
- **Monorepos**: connect `owner/name#apps/web` (or a github `tree` URL). The sandbox, the original and the rebuild start in that folder (never outside the checkout). Run against this very repository: the folder is found; the sandbox now says plainly that an app with `workspace:*` dependencies cannot run alone, instead of failing inside `npm install`.
- **Starter templates**: plain HTML, **Vite + React**, **Next.js** (all load the SDK bundle from `public/`, so no npm publish is needed). Both framework templates were run for real: npm install, dev server, 100% of the map reached, every phrase understood. No Expo template: the bundle is DOM-based.
- **Evals** (`pnpm --filter @entoli/web eval`; the deterministic ones also run in `pnpm test`): device matcher (37 labelled phrases), analyzer (notes app), proposal (vs. a careful human), and a **live Claude resolver eval** (skipped without `ANTHROPIC_API_KEY`). **They found real bugs, now fixed**: "find meeting notes" and "show notes about travel" ran *Open* instead of *Search* (a slot value alone outranked a phrase the person said), "export my notes to pdf" ran *Open* instead of saying the app can't, and the analyzer invented an "Example" feature from demo chips. Matcher now: 28/29, **0 wrong acts**, 0 acts for non-requests. Floors are enforced.
- **Accessibility and mobile**: axe-core (WCAG 2.1 A/AA + best practice) at 375 px and 1280 px over 21 pages: fixed heading order, colour contrast, keyboard access to code blocks, empty table headers, landmarks (the Stage is now a labelled region). `pnpm --filter @entoli/web a11y` repeats it (it caught one of my own regressions). No sideways scrolling at phone width.
- **First run**: a "Getting started" checklist computed from what exists (7 steps, next one highlighted); sandbox and project failures explained in plain words with the fix, technical detail folded away.
- **Smoke test** against your real accounts: `pnpm --filter @entoli/web smoke` (database + migrations, both GitHub credentials, Claude, Stripe prices/meters/webhook, OpenAI key mint, Vercel Sandbox boot, hosted browser, cron route). `/api/health` added.
- **Landing**: a "Say the app into existence" section with the recorded run.

**Not done, and why**
- **ElevenLabs provider**: not built. It needs their realtime speech-to-text and streaming text-to-speech protocols; I cannot reach their docs from here and will not write a provider from memory. The `LiveProvider` interface is ready.
- **Contract replays for OpenAI, GitHub, Vercel Sandbox**: not possible without reaching their APIs; the smoke test is the replacement (it checks the real shapes on day one). Stripe webhooks were already tested with the real library's signing.
- The device matcher still misses vague paraphrases without a number ("make the text bigger"): Layer 2 handles those; the live resolver eval measures it once you have a key.

## Static site
`site/` is the canonical marketing page (also deployable alone: Root Directory `site`, Framework Other).
