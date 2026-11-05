import { describe, expect, it } from 'vitest';
import { validateSkill, assertSkill } from '../src/skill.js';
import { skill } from './fixture.js';

const clone = () => JSON.parse(JSON.stringify(skill));

describe('skill validator', () => {
  it('accepts a valid skill', () => {
    const r = validateSkill(clone());
    expect(r.ok).toBe(true);
  });
  it('refuses slot types outside the closed set', () => {
    const s = clone(); s.acts[0].slots.text.type = 'email';
    const r = validateSkill(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/closed set/);
  });
  it('allows settings on either layer (the layer is about AI, not reach)', () => {
    const s = clone(); s.layer = 'L1';
    expect(validateSkill(s).ok).toBe(true);
  });
  it('catches duplicates, unknown parents, unknown acts and bad radius', () => {
    const s = clone();
    s.acts.push({ ...s.acts[0] });
    s.map.push({ id: 'x', kind: 'button', title: 'X', parent: 'nope', act: 'ghost' });
    s.acts[1].radius = 'world';
    const r = validateSkill(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.errors.join('\n');
      expect(all).toMatch(/duplicate act/);
      expect(all).toMatch(/unknown node "nope"/);
      expect(all).toMatch(/unknown act "ghost"/);
      expect(all).toMatch(/radius/);
    }
  });
  it('only choice and person slots take options', () => {
    const s = clone(); s.acts[0].slots.text.options = ['a'];
    expect(validateSkill(s).ok).toBe(false);
  });
  it('warns on self without undo', () => {
    const s = clone(); delete s.acts[0].undo;
    const r = validateSkill(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/without undo/);
  });
  it('assertSkill throws with every error', () => {
    expect(() => assertSkill({})).toThrow(/entoli[\s\S]*app\.name[\s\S]*layer/);
  });
});
