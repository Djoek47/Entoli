/**
 * "What should Entoli take over?": does the proposal agree with what a careful
 * person would choose for the notes app? The safety number is DANGEROUS: an act
 * that cannot be undone, or that reaches outside the app, must never be handed
 * to the AI.
 */
import { describe, expect, it } from 'vitest';
import type { Skill } from '@entoli/sdk/skill';
import raw from '../../../examples/notes-app/entoli.skill.json';
import { buildProposal } from '../src/lib/proposal';
import { PROPOSAL } from './cases';
import { report } from './report';

const skill = raw as unknown as Skill;

describe('proposal', () => {
  it('agrees with a careful human, and never hands a dangerous act to the AI', () => {
    const p = buildProposal(skill);
    const rows = p.items.map((i) => ({ ok: PROPOSAL[i.act] === i.recommend ? '✓' : '✗', act: i.act, expected: PROPOSAL[i.act] ?? '?', got: i.recommend }));
    const agree = rows.filter((r) => r.ok === '✓').length;
    const dangerous = p.items.filter((i) => {
      const a = skill.acts.find((x) => x.name === i.act)!;
      return i.recommend === 'L2' && (a.radius === 'external' || (!a.undo && a.radius !== 'self'));
    });
    report('proposal', rows, { acts: rows.length, agree: `${agree}/${rows.length}`, DANGEROUS: dangerous.length });
    expect(dangerous).toEqual([]);
    expect(agree / rows.length).toBeGreaterThanOrEqual(0.75);
  });
});
