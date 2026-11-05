import { describe, expect, it } from 'vitest';
import { canonical, fingerprint, HOLD_MS, planCommit } from '../src/contract.js';

describe('commit contract', () => {
  it('self + undo holds for 1.6 s', () => {
    expect(planCommit({ radius: 'self', undo: true }, 'text')).toMatchObject({ assent: 'hold', holdMs: 1600 });
    expect(HOLD_MS).toBe(1600);
  });
  it('anything else needs a yes', () => {
    expect(planCommit({ radius: 'self', undo: false }, 'text').assent).toBe('yes');
    expect(planCommit({ radius: 'other-person', undo: true }, 'text').assent).toBe('yes');
    expect(planCommit({ radius: 'self', undo: true, kind: 'setting' }, 'voice').assent).toBe('yes');
    expect(planCommit({ radius: 'self', undo: true, fromModel: true }, 'text').assent).toBe('yes');
  });
  it('external and exact need "Do exactly this"', () => {
    expect(planCommit({ radius: 'external', undo: true }, 'voice').assent).toBe('exact');
    expect(planCommit({ radius: 'self', undo: true, exact: true }, 'text').assent).toBe('exact');
  });
  it('voiceOnly refuses typed requests', () => {
    expect(planCommit({ radius: 'external', undo: false, voiceOnly: true }, 'text').assent).toBe('blocked');
    expect(planCommit({ radius: 'external', undo: false, voiceOnly: true }, 'voice').assent).toBe('exact');
  });
});

describe('fingerprint', () => {
  it('is stable across key order and changes with any argument', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    const a = fingerprint('settings.email', { email: 'a@x.com', notify: true });
    expect(fingerprint('settings.email', { notify: true, email: 'a@x.com' })).toBe(a);
    expect(fingerprint('settings.email', { email: 'a@x.co', notify: true })).not.toBe(a);
    expect(fingerprint('settings.other', { email: 'a@x.com', notify: true })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
