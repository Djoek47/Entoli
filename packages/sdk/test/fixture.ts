import type { Skill } from '../src/skill.js';
import type { Timers } from '../src/runtime.js';

export const skill: Skill = {
  entoli: '0.1',
  app: { name: 'Notes' },
  layer: 'L2',
  mode: 'text',
  map: [
    { id: 'notes', kind: 'screen', title: 'Notes', path: '/' },
    { id: 'notes.new', kind: 'button', title: 'New note', parent: 'notes', act: 'note.create' },
    { id: 'settings', kind: 'screen', title: 'Settings', path: '/settings' },
  ],
  knowledge: [
    { topic: 'export to PDF', can: false, answer: 'No. Notes cannot be exported to PDF yet.', phrases: ['print notes'] },
    { topic: 'tags', can: true, answer: 'Yes. Say "tag this note work".' },
  ],
  acts: [
    { name: 'note.create', title: 'New note', phrases: ['new note', 'add a note', 'write down'], radius: 'self', undo: true, screen: 'notes',
      slots: { text: { type: 'freeText', required: true, prompt: 'What should it say?' } } },
    { name: 'settings.theme', title: 'Change theme', phrases: ['theme', 'switch to'], radius: 'self', undo: true, kind: 'setting', screen: 'settings',
      slots: { theme: { type: 'choice', required: true, options: [{ value: 'dark', aliases: ['dark mode', 'night'] }, { value: 'light', aliases: ['light mode'] }] } } },
    { name: 'settings.email', title: 'Change email', phrases: ['change my email', 'email address'], radius: 'external', voiceOnly: true, exact: true, kind: 'setting', screen: 'settings',
      slots: { email: { type: 'freeText', required: true, prompt: 'New email address?' } } },
    { name: 'note.share', title: 'Share note', phrases: ['share note'], radius: 'other-person', undo: true,
      slots: { person: { type: 'person', required: true, options: ['Maya', 'Sam'] } } },
  ],
};

export class FakeTimers implements Timers {
  t = 1_000_000;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  now() { return this.t; }
  set(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; }
  clear(id: unknown) { this.q = this.q.filter((x) => x.id !== id); }
  async advance(ms: number) {
    this.t += ms;
    const due = this.q.filter((x) => x.at <= this.t);
    this.q = this.q.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
    await new Promise((r) => setTimeout(r, 0));
  }
}
