/**
 * Layer 1: how well the on-device matcher (no AI, no network) understands
 * phrases. The number that matters most is WRONG ACT: running a different act
 * than the person meant. Not understanding is acceptable (it asks or says so);
 * doing the wrong thing is not.
 */
import { describe, expect, it } from 'vitest';
import { Entoli, type Timers } from '@entoli/sdk';
import type { Skill } from '@entoli/sdk/skill';
import raw from '../../../examples/notes-app/entoli.skill.json';
import { PHRASES } from './cases';
import { report } from './report';

const skill = raw as unknown as Skill;
const timers: Timers = { now: () => 0, set: () => 0, clear: () => {} };

describe('device matcher', () => {
  it('understands the notes app, and never confidently does the wrong thing', async () => {
    const rows: Record<string, string | number>[] = [];
    let right = 0, wrong = 0, unsure = 0, falseRun = 0;
    for (const c of PHRASES) {
      const e = new Entoli({ skill: { ...skill, layer: 'L1' }, layer: 'L1', timers });
      for (const a of skill.acts) e.register(a.name, {}, async () => null);
      const s = await e.hear(c.phrase, { channel: 'text' });
      const got = s.act ?? (s.choices?.length === 1 ? s.choices[0]!.act : null);
      let ok: boolean;
      if (c.act === null) {
        ok = got === null || s.phase === 'answer' || s.phase === 'none';
        if (!ok) falseRun++;
      } else if (got === c.act) { ok = true; right++; }
      else if (got === null) { ok = false; unsure++; }
      else { ok = false; wrong++; }
      rows.push({ ok: ok ? '✓' : '✗', phrase: c.phrase, expected: c.act ?? '(none)', got: got ?? s.phase, note: c.note ?? '' });
    }
    const acts = PHRASES.filter((c) => c.act !== null).length;
    report('device', rows, { phrases: PHRASES.length, understood: `${right}/${acts}`, 'asked or unsure': unsure, 'WRONG ACT': wrong, 'ran something for a non-act': falseRun });
    // The floor. Raise it when the matcher improves; never lower it to make a regression pass.
    expect(wrong).toBe(0);
    expect(falseRun).toBe(0);
    expect(right / acts).toBeGreaterThanOrEqual(0.95);
  });
});
