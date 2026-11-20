# What you have to set up

Everything below is an account, a key or a decision only you can make. Nothing in the code needs a secret to build, test or run locally (without keys the dashboard uses an in-process Postgres, a local "dev" user and no billing). Set env vars in Vercel (Project → Settings → Environment Variables); `.env.example` lists all of them with comments.

## Order that gets you live fastest

1. **Domain and project**: buy `entoli.dev`; create a Vercel project from this repo with root directory `apps/web`. Set `APP_URL=https://entoli.dev`.
2. **Database**: create a Neon (or Marketplace Postgres) database → `DATABASE_URL`. Production does **not** migrate on its own: run `DATABASE_URL=… pnpm --filter @entoli/web db:migrate` once, and again after each deploy that adds a migration (`apps/web/drizzle`, 0000–0010 today).
3. **Sign-in**: GitHub → Settings → Developer settings → OAuth App, callback `https://entoli.dev/api/auth/callback/github` → `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`; `AUTH_SECRET` = `openssl rand -base64 32`.
4. **GitHub App** (read-only repo access, write only for guided-integration PRs): Setup URL `https://entoli.dev/api/github/setup` with "Redirect on update" → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`. Permissions: Contents read & write, Pull requests read & write, Metadata read.
5. **Claude**: `ANTHROPIC_API_KEY` (analysis review, Layer 2 answers, skill drafting, wiring edits). Optional `ENTOLI_MODEL`.
6. **Stripe**: create the account, then run `node apps/web/scripts/stripe-setup.mjs` once per mode (test, then live; it creates the meters, products and prices by lookup key). Add a webhook endpoint `https://entoli.dev/api/stripe/webhook` → `STRIPE_WEBHOOK_SECRET`; set `STRIPE_SECRET_KEY`; enable the customer portal; `CRON_SECRET` = any long random string (Vercel Cron calls `/api/cron/usage` with it).
7. **Publish the SDK**: `npm publish` `@entoli/sdk` (the docs and the integration tell developers to `npm i @entoli/sdk`). Claim the `@entoli` npm scope first.
8. **Voice**: `OPENAI_API_KEY` (Realtime; server-only, the browser only ever receives 2-minute keys). `VOICE_PROVIDER=openai`. Without it the orb falls back to the browser's own speech recognition.
9. **Test sandbox**: on Vercel the OIDC token is automatic (`SANDBOX_PROVIDER` defaults to `vercel` in production). Elsewhere set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`. The local provider is refused in production.
10. **Hosted browser for the checks** (map walk, phrase checks in the dashboard): a Playwright-compatible Chromium endpoint (Browserbase, Browserless, or your own) → `BROWSER_WS_ENDPOINT`.

## Check it all with one command

Once the keys are in your environment (`vercel env pull .env.local` then `set -a; . apps/web/.env.local; set +a`), run:

```bash
pnpm --filter @entoli/web smoke
```

It checks the database and migrations, both GitHub credentials, Claude, Stripe (prices, meters, webhook endpoint), OpenAI Realtime (mints a key), the Vercel Sandbox (boots one, runs node, stops it), the hosted browser and the cron route. Each line is PASS, FAIL with the reason, or SKIP (keys not set). It never charges anything and never prints a secret.

## Optional

- Tuning: `VOICE_TOOL_TURNS` (300), `VOICE_LIVE_MINUTES` (120), `INTENT_RATE_PER_MIN` (120), `ANALYSIS_MAX_INPUT_TOKENS`, `ANALYSIS_MAX_OUTPUT_TOKENS`.
- The marketing site's own Ask bar: `NEXT_PUBLIC_ENTOLI_SITE_KEY`, `NEXT_PUBLIC_ENTOLI_ENDPOINT`.
- Docs on GitBook: Git Sync pointed at this repo's `docs/` folder (`.gitbook.yaml`), custom domain `docs.entoli.dev`.

## Decisions and reviews that are yours

- **Lawyer review** of `/terms` and `/privacy` (both marked drafts).
- **Limits and prices**: 300 dashboard instructions and 120 live minutes a month on L2, the free Developer plan, $49 / $299, $0.015 per AI voice turn, $2 per extra 1,000 intents. All in `apps/web/src/lib/plans.ts`; the pricing page reads from it.
- **ElevenLabs** as a second voice provider is not built (the interface is ready: `LiveProvider`).

## What is verified, and what is not

Verified here with real code, database, browser and MCP handler: the whole flow in `docs/DEMO_RUN.md`, the sandbox on real downloaded apps, the MCP server with a real MCP client, the design extractor on this repo.

Not run live (needs the accounts above): OpenAI Realtime audio, Claude's answers and drafts, Stripe checkout and webhooks, the GitHub App pull-request step, the Vercel Sandbox provider, the hosted browser. Each is built against an interface with a tested local or fake implementation; `STATUS.md` says which for every milestone.
