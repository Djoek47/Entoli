# Entoli

The developer site for Entoli, the AIUIC for developers. A single static page: no build step, no keys.

## Deploy on Vercel
1. Put these files at the root of the `Djoek47/entoli` repository.
2. In Vercel: Add New → Project → Import `Djoek47/entoli` → Deploy. Framework: Other. No settings needed.

## What is real and what is simulated
- Real: the whole page, the Ask Entoli bar (operates the page by intent), the app map, knowledge, skill file and guided-integration flow.
- Simulated in this preview: GitHub sign-in, repository analysis, payments, and the waitlist. These need a server (next build).
