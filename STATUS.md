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

## Static site
`site/` is the canonical marketing page (also deployable alone: Root Directory `site`, Framework Other).
