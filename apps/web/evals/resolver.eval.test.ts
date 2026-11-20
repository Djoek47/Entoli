/**
 * Layer 2: Claude choosing an act for phrases the device could not settle.
 * LIVE: needs ANTHROPIC_API_KEY, costs a few cents, and is skipped without it.
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @entoli/web eval resolver
 *
 * Two numbers: accuracy on real requests, and FALSE ACTS, where the model picked
 * an act for something that is not a request (it must say "none").
 */
import { describe, expect, it } from 'vitest';
import type { Skill } from '@entoli/sdk/skill';
import raw from '../../../examples/notes-app/entoli.skill.json';
import { claudeChooser, type CandidateAct } from '../src/lib/intent';
import { report } from './report';

const skill = raw as unknown as Skill;
const live = !!process.env.ANTHROPIC_API_KEY;

const acts: CandidateAct[] = skill.acts.filter((a) => a.name !== 'settings.email').map((a) => ({
  name: a.name, title: a.title ?? a.name, phrases: a.phrases,
  slots: Object.entries(a.slots ?? {}).map(([name, s]) => ({ name, type: s.type, ...(s.options ? { options: s.options.map((o) => (typeof o === 'string' ? o : o.value)) } : {}) })),
}));

// Phrases the device alone would struggle with: paraphrase, indirection, vagueness.
const CASES: { phrase: string; act: string | null }[] = [
  { phrase: 'jot down that the boiler needs servicing', act: 'note.create' },
  { phrase: 'I need to remember to call Priya on Friday', act: 'note.create' },
  { phrase: 'where did I put my notes about the budget', act: 'note.search' },
  { phrase: 'anything in here on the Lisbon trip?', act: 'note.search' },
  { phrase: 'this one is for work', act: 'note.tag' },
  { phrase: 'get rid of that note', act: 'note.delete' },
  { phrase: 'my eyes are tired, can it be darker', act: 'settings.theme' },
  { phrase: 'the text is tiny, make it 22', act: 'settings.fontSize' },
  { phrase: 'take me back to my notes', act: 'nav.open' },
  { phrase: 'what is the capital of France', act: null },
  { phrase: 'thanks, that was great', act: null },
  { phrase: 'do not delete anything', act: null },
  { phrase: 'could you delete my whole account', act: null },
  { phrase: 'I wonder whether dark mode is easier on the eyes', act: null },
];

describe.skipIf(!live)('resolver (live, Claude)', () => {
  it('picks the right act, and does not act on what is not a request', async () => {
    const rows: Record<string, string | number>[] = [];
    let right = 0, falseActs = 0, wrongActs = 0;
    for (const c of CASES) {
      const { choice } = await claudeChooser({ phrase: c.phrase, acts, appName: skill.app.name });
      const got = choice?.act ?? null;
      const ok = got === c.act;
      if (ok) right++; else if (c.act === null) falseActs++; else if (got !== null) wrongActs++;
      rows.push({ ok: ok ? '✓' : '✗', phrase: c.phrase, expected: c.act ?? '(none)', got: got ?? '(none)' });
    }
    report('resolver', rows, { cases: CASES.length, accuracy: `${right}/${CASES.length}`, 'FALSE ACTS': falseActs, 'wrong act': wrongActs });
    expect(falseActs).toBe(0);
    expect(wrongActs).toBe(0);
    expect(right / CASES.length).toBeGreaterThanOrEqual(0.85);
  });
});
