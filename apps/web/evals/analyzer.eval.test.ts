/**
 * The static analyzer (no model): does it find the notes app's real features,
 * and does it invent any? Ground truth is what the app really does. The model
 * pass (ANTHROPIC_API_KEY) is evaluated separately in resolver.eval.test.ts's
 * sibling when a key is present; this one is deterministic and runs everywhere.
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '@entoli/analyzer';
import { report } from './report';

// concept → a pattern its act name or title should match
const TRUTH: Record<string, RegExp> = {
  'create a note': /add.?note|new.?note|create.?note/i,
  'search notes': /search/i,
  'tag a note': /tag/i,
  'delete a note': /remove|delete/i,
  'change theme': /theme/i,
  'change font size': /font/i,
  'open a screen': /nav|screen|navigate|open/i,
};
// names that are NOT features a person would ask for
const NOT_FEATURES = [/example/i];
// Known gaps, not scored: 'change email' has no UI control in the app (it is voice-only), so no static scan can find it.

describe('static analyzer on the notes app', () => {
  it('finds the real features, and says how many it invents', async () => {
    const r = await analyze(new URL('../../../examples/notes-app', import.meta.url).pathname, { ai: false });
    const acts = r.skill.acts.map((a) => ({ name: a.name, text: `${a.name} ${a.title ?? ''}` }));
    const rows = Object.entries(TRUTH).map(([concept, re]) => ({ ok: acts.some((a) => re.test(a.text)) ? '✓' : '✗', concept, found: acts.find((a) => re.test(a.text))?.name ?? '(missing)' }));
    const spurious = acts.filter((a) => NOT_FEATURES.some((re) => re.test(a.name)));
    const recall = rows.filter((x) => x.ok === '✓').length;
    report('analyzer', [...rows, ...spurious.map((s) => ({ ok: '✗', concept: 'NOT A FEATURE', found: s.name }))], { acts: acts.length, recall: `${recall}/${rows.length}`, invented: spurious.length });
    // Floors as measured on 2026-11-20. Raise them when the analyzer improves. Missing: navigation buttons that call a state setter.
    expect(recall).toBeGreaterThanOrEqual(6);
    expect(spurious.length).toBe(0);
  });
});
