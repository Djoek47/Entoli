# Entoli

The AIUIC for developers. Connect your app's repository; Entoli maps every screen, button and setting, drafts what the app can and can't do, and gives you a skill (`entoli.skill.json`) plus an SDK so people can operate your app by intent, typed or spoken.

**Two layers, chosen per feature.** Layer 1: no AI; the user types or speaks and the menu responds on the device. Layer 2: Entoli's AI answers the user, then makes the change through your UI. Each act can be L1, L2 or off (not connected).

**Two plans.** L1 ($49/app/month) is the skill: analyzer, map, SDK, tester, and an export for Claude Code, Cursor or any agent so your own tools wire it in. L2 ($299/app/month) is the skill and the integration: Entoli's AI answers your users, and the voice tool lets you connect GitHub and speak the integration into existence; the dashboard runs on Entoli itself.

The AI only chooses among acts you declare and wire to your real functions. Small, reversible actions run after a 1.6 s visible hold with a way out; anything else waits for a yes; anything that reaches outside shows exactly what will run, and the yes is bound to that.

## Integrate in 3 steps

**1. Get a skill.** Connect the repository in the dashboard and press Analyze, or run the analyzer yourself:

```bash
npx entoli analyze ./my-app
```

Review the draft (acts, their radius and undo, knowledge). Nothing is published until you do.

**2. Mount the bar.**

```bash
npm i @entoli/sdk
```

```ts
import { mount } from '@entoli/sdk';
import skill from './entoli.skill.json';

mount({ el: '#entoli', skill, mode: 'voice', key: import.meta.env.VITE_ENTOLI_KEY });
```

**3. Wire each act to the function that already does it.**

```tsx
import { useEntoli } from '@entoli/sdk/react';

useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), {
  undo: (note) => removeNote(note.id),
});
```

Plain JavaScript uses `defineAct(name, slots, handler, options)`. Or skip the typing: on L1, download the skill for your coding agent (Skill tab); on L2, speak to the dashboard ("integrate new note and search by voice", "approve all", "open the pull request") and approve the pull request it prepares. Check the result with `npx entoli-test entoli.skill.json <preview-url>`.

Full docs: `/docs` in the web app (quickstart, skill format, safety model, pricing).

## Repository

| Path | What |
|---|---|
| `packages/sdk` | `@entoli/sdk`: `mount`, `useEntoli`, `defineAct`, command bar and Stage, commit contract, on-device resolver (ported from tacit), voice, skill schema and validator |
| `packages/analyzer` | `entoli analyze`: static scan of React / Next.js / Vue, draft skill, optional Claude review |
| `packages/tester` | `entoli-test`: Playwright walk of the map, coverage and broken paths |
| `examples/notes-app` | Fieldnotes, the end-to-end demo (Vite + React), fully wired |
| `apps/web` | Next.js app: marketing site, GitHub login, dashboard, `/api/intent`, analysis, billing, guided integration, tests |
| `site` | The original static marketing page (source of truth for `/`) |

`STATUS.md` records, per milestone, what is real, what is stubbed and how to run it.

## Run locally

Node 22 and pnpm 10.

```bash
pnpm install
pnpm test
```

```bash
pnpm --filter @entoli/web dev
```

The dashboard runs at http://localhost:3000 with no accounts at all: an in-process Postgres (PGlite), a local "dev" user, and a plan switcher in place of Stripe. The demo:

```bash
pnpm --filter @entoli/example-notes dev
```

## Deploy (Vercel)

- **Web app**: new project, Root Directory `apps/web`, framework Next.js. Fill the variables from `.env.example`, then run the migrations once against the database: `DATABASE_URL=… pnpm --filter @entoli/web db:migrate`.
- **Demo**: new project, Root Directory `examples/notes-app`.
- **Static site only**: Root Directory `site`, framework Other.

## Safety and privacy, in short

Repositories are read through a read-only GitHub App installation and deleted after each job; write access is requested only to open the integration pull request. App keys are public client keys, hashed at rest, rate-limited, optionally restricted to your origins. Secrets live in environment variables only.
