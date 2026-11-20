import { describe, expect, it } from 'vitest';
import { Entoli } from '../src/runtime.js';
import type { Skill } from '../src/skill.js';
import { FakeTimers } from './fixture.js';

// Found by the device eval (apps/web/evals): a slot value alone ("notes") must not beat a phrase the person said.
const skill: Skill = {
  entoli: '0.1', app: { name: 'Notes' }, layer: 'L1', mode: 'text',
  map: [{ id: 'notes', kind: 'screen', title: 'Notes', path: '/' }, { id: 'settings', kind: 'screen', title: 'Settings', path: '/settings' }],
  knowledge: [{ topic: 'export to PDF', can: false, answer: 'No. Notes cannot be exported.', phrases: ['download notes'] }],
  acts: [
    { name: 'note.search', title: 'Search notes', phrases: ['search', 'find', 'show notes about'], radius: 'self', undo: true, slots: { query: { type: 'freeText', required: true } } },
    { name: 'nav.open', title: 'Go to', phrases: ['go to', 'open', 'show'], radius: 'self', undo: true, slots: { screen: { type: 'choice', required: true, options: ['notes', 'settings'] } } },
    { name: 'settings.theme', title: 'Change theme', phrases: ['theme'], radius: 'self', undo: true, slots: { theme: { type: 'choice', required: true, options: [{ value: 'dark', aliases: ['dark mode'] }, 'light'] } } },
  ],
};

async function hear(text: string) {
  const e = new Entoli({ skill, timers: new FakeTimers(), layer: 'L1' });
  for (const a of skill.acts) e.register(a.name, {}, async () => null, { undo: () => {} });
  return e.hear(text);
}

describe('matching: the phrase the person said beats a slot value alone', () => {
  it('"find meeting notes" is search, not "go to notes"', async () => expect((await hear('find meeting notes')).act).toBe('note.search'));
  it('"show notes about travel": the longer phrase wins over "show"', async () => expect((await hear('show notes about travel')).act).toBe('note.search'));
  it('"show settings" is still navigation', async () => expect((await hear('show settings')).act).toBe('nav.open'));
  it('a slot value alone still finds an act when nothing else competes ("dark mode")', async () => expect((await hear('dark mode')).act).toBe('settings.theme'));
  it('does not act when the app says it cannot do what was asked', async () => {
    const s = await hear('export my notes to pdf');
    expect(s.act).toBeUndefined();
    expect(s.phase).toBe('answer');
    expect(s.can).toBe(false);
  });
});
