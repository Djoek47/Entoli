# A recorded end-to-end run

Produced by `apps/web/test/demo.test.ts`. Real database, real MCP handler, real sandbox, real Chromium. The voice provider is a fake (it only carries text), and the model that drafts the skill and the coding agent are scripted, so this shows the *flow and the guardrails*, not the quality of a real model. Regenerate with `ENTOLI_WRITE_DEMO=1 pnpm --filter @entoli/web test demo`.

**You:** Build me a todo app. I can add todos, and see the ones I have done.

**Entoli:** I wrote the skill first: 2 screens, 3 features, and a starter app that already runs (7 files).

**You:** What should I expose?

**Entoli:** I found 3 features. I would hand Add a todo to the AI, because one sentence saves several clicks. I would keep Open done on the device: it is short and needs no AI. And I would leave Delete account manual, because it reaches outside the app or cannot be undone. That changes 2. Say accept to apply it, or ask why about any of them.

**You:** Why is delete account manual?

**Entoli:** Delete account: I would put it on kept manual. It cannot be undone and it looks destructive, so I would keep it manual. Exposed later, it would always ask for a yes.

**You:** Accept the proposal.

**Entoli:** This changes what the AI can reach. Say yes to go ahead, or no.

**You:** Yes.

**Entoli:** Done. I changed 2 features. You can say undo, or move any of them yourself.

> The developer’s coding agent connects over MCP and builds the app.

**Entoli:** The guardrails stopped your agent: .env: ".env" is not a file a project may hold (secrets, git data and installed packages are never part of it). Your agent submitted a change to app.js: Build the todo list and wire add and show. It is waiting for your approval. Your agent wired todo add.

**You:** Approve all.

**Entoli:** Approved 1 change. It is written into your project.

**You:** Run it in the sandbox and check it.

**Entoli:** It is running. I walked the map: 2 of 2 screens reached. I typed each feature's phrase into the bar: 2 of 2 understood.

**You:** Give me the project.

**Entoli:** Here is your project: 7 files, 24 kB zipped. Nothing was ever in a repository.

