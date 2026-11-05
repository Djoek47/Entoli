// End to end inside jsdom: the real App, the real skill, the real SDK.
import { mount, validateSkill, type Mounted } from '@entoli/sdk';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import skill from '../entoli.skill.json';
import { App } from '../src/App.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Timers {
  t = Date.now(); q: { at: number; fn: () => void; id: number }[] = []; n = 0;
  now() { return this.t; }
  set(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; }
  clear(id: unknown) { this.q = this.q.filter((x) => x.id !== id); }
  async advance(ms: number) { this.t += ms; const due = this.q.filter((x) => x.at <= this.t); this.q = this.q.filter((x) => x.at > this.t); due.forEach((d) => d.fn()); await new Promise((r) => setTimeout(r, 0)); }
}

let e: Mounted, root: Root, host: HTMLElement, timers: Timers;
const say = async (t: string, channel: 'text' | 'voice' = 'text') => { await act(async () => { await e.hear(t, { channel }); }); return e.state; };
const tick = async (ms: number) => act(async () => { await timers.advance(ms); });
const yes = async () => act(async () => { await e.confirm(e.state.fingerprint); });

beforeEach(async () => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.body.innerHTML = '<div id="root"></div><div id="dock"></div>';
  timers = new Timers();
  e = mount({ el: '#dock', skill, mode: 'voice', fonts: false, timers });
  host = document.getElementById('root')!;
  root = createRoot(host);
  await act(async () => root.render(<App />));
});
afterEach(async () => { await act(async () => root.unmount()); e.unmount(); });

const noteTexts = () => [...host.querySelectorAll('.list li p')].map((p) => p.textContent);

describe('Fieldnotes, operated by intent', () => {
  it('ships a valid skill and wires every declared act', () => {
    expect(validateSkill(skill).ok).toBe(true);
    expect(e.unwired()).toEqual([]);
  });

  it('new note: holds 1.6 s, then creates; undo removes it', async () => {
    expect((await say('new note book the dentist')).phase).toBe('hold');
    await tick(1600);
    expect(noteTexts()[0]).toBe('book the dentist');
    await act(async () => { await e.undo(e.state.receipts[0]!.id); });
    expect(noteTexts()).not.toContain('book the dentist');
  });

  it('search filters the list, and undo clears it', async () => {
    await say('search for milk');
    await tick(1600);
    expect(noteTexts()).toEqual(['Buy milk, eggs and coffee']);
    await act(async () => { await e.undo(e.state.receipts[0]!.id); });
    expect(noteTexts()).toHaveLength(3);
  });

  it('tags the selected note', async () => {
    await say('tag it work');
    await tick(1600);
    expect(host.querySelector('.list li.sel .t-work')).not.toBeNull();
  });

  it('theme and font size are settings: they wait for a yes', async () => {
    expect((await say('switch to dark mode')).phase).toBe('confirm');
    await tick(5000);
    expect(document.documentElement.dataset.theme).toBe('light');
    await yes();
    expect(document.documentElement.dataset.theme).toBe('dark');

    expect((await say('set font size to 18')).phase).toBe('confirm');
    await yes();
    expect(document.documentElement.style.getPropertyValue('--fs')).toBe('18px');

    const bad = await say('set font size to 40');
    expect(bad.phase).toBe('error');
    expect(bad.message).toMatch(/between 12 and 24/);
  });

  it('email: refused when typed; spoken shows exactly the address and needs that yes', async () => {
    expect((await say('change my email to ana@example.com')).phase).toBe('blocked');
    const s = await say('change my email to Ana at example dot com', 'voice');
    expect(s.phase).toBe('exact');
    expect(document.querySelector('.entoli-card .entoli-args code')!.textContent).toBe('ana@example.com');
    await yes();
    expect(host.querySelector('[data-testid=email]')!.textContent).toBe('ana@example.com');
  });

  it('answers knowledge questions from the skill only', async () => {
    expect((await say('can it export to PDF?')).can).toBe(false);
    expect((await say('does it work offline?')).can).toBe(true);
    expect((await say('can it play music?')).can).toBeNull();
  });

  it('navigates', async () => {
    await say('go to settings');
    await tick(1600);
    expect(host.querySelector('[data-screen=settings]')).not.toBeNull();
  });
});
