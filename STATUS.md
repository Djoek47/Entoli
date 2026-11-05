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

## Marketing site
The original static page is in `site/` unchanged. On Vercel, until `apps/web` exists, set the project's Root Directory to `site` (Framework: Other, no build).
