import { describe, expect, it } from 'vitest';
import { explainFailure } from '@/lib/sandbox-hints';

describe('sandbox failure hints', () => {
  it.each([
    ['Repository not found. If it is private, connect it with the GitHub App.', /GitHub App/],
    ['This app depends on packages inside its own monorepo (@acme/ui)', /installs on its own/],
    ['This app has no package.json at its root', /owner\/name#apps\/web/],
    ['package.json has no "dev" or "start" script to run.', /"dev" or "start"/],
    ['npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency', /conflicting versions/],
    ['Installing dependencies failed (exit 1).', /clean checkout/],
    ['The app did not answer on its port within 120 s (fetch failed).', /database or an API key/],
    ['The repository is too large to run in a test sandbox', /owner\/name#folder/],
  ])('%s', (error, fix) => {
    const h = explainFailure(error)!;
    expect(h.what.length).toBeGreaterThan(10);
    expect(h.fix).toMatch(fix);
  });
  it('has a fallback, and says nothing when nothing failed', () => {
    expect(explainFailure('something odd')!.what).toBe('The sandbox failed.');
    expect(explainFailure(null)).toBeNull();
  });
});
