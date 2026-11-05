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

## Static site
`site/` is the canonical marketing page (also deployable alone: Root Directory `site`, Framework Other).
