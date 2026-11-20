/** Turn a sandbox failure into what it means and what to do about it, in plain words. */
export type Hint = { what: string; fix: string };

const RULES: [RegExp, Hint][] = [
  [/Repository not found/i, { what: 'Entoli could not download the repository.', fix: 'If it is private, install the read-only Entoli GitHub App on it (Map tab). Otherwise check the name.' }],
  [/inside its own monorepo/i, { what: 'The app depends on packages that live elsewhere in its monorepo.', fix: 'Connect an app that installs on its own, or use the Skill tab to hand the skill to your agent and test in your own setup.' }],
  [/no package\.json/i, { what: 'There is no package.json where Entoli looked.', fix: 'For an app inside a monorepo, connect its folder: owner/name#apps/web.' }],
  [/no "dev" or "start" script/i, { what: 'Entoli does not know how to start this app.', fix: 'Add a "dev" or "start" script to package.json.' }],
  [/ERESOLVE|peer dep|Could not resolve dependency/i, { what: 'Installing dependencies hit a version conflict.', fix: 'Fix the conflicting versions in package.json (npm install must succeed from a clean checkout).' }],
  [/Installing dependencies failed/i, { what: 'npm install failed in a clean sandbox.', fix: 'Run npm install from a clean checkout yourself; private packages and install scripts that need secrets do not work here. The log above has the last lines.' }],
  [/did not answer on its port|exited before it was ready/i, { what: 'The app started but never answered.', fix: 'It may need a database or an API key the sandbox does not have (no secrets are copied in), or it listens on a fixed port. Use process.env.PORT, and let it start without external services.' }],
  [/too large/i, { what: 'The repository is bigger than a test sandbox accepts.', fix: 'Connect the app folder (owner/name#folder) instead of the whole repository.' }],
  [/Six sandboxes an hour|already starting/i, { what: 'Too many sandboxes at once.', fix: 'Wait a few minutes; one sandbox runs per app at a time.' }],
  [/No browser on this deployment|BROWSER_WS_ENDPOINT/i, { what: 'The checks need a browser and this deployment has none.', fix: 'Set BROWSER_WS_ENDPOINT (see docs/SETUP.md).' }],
  [/project has no files/i, { what: 'The project is empty.', fix: 'Start it again, or approve a change from your agent first.' }],
];

export function explainFailure(error: string | null | undefined): Hint | null {
  if (!error) return null;
  return RULES.find(([re]) => re.test(error))?.[1] ?? { what: 'The sandbox failed.', fix: 'The log above shows where. If it is not clear, copy it into your coding agent.' };
}
