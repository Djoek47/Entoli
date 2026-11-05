// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAct, mount } from '../src/index.js';
import type { SpeechProvider } from '../src/voice.js';
import { skill, FakeTimers } from './fixture.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
let off: (() => void)[] = [];
afterEach(() => { off.forEach((f) => f()); off = []; document.body.innerHTML = ''; });

function type(text: string) {
  const input = document.querySelector<HTMLInputElement>('.entoli-input')!;
  input.value = text;
  input.form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.entoli-btn')].find((b) => b.textContent === label);

describe('mount + Stage', () => {
  it('draws the bar and one card, with "Not that" during the hold', async () => {
    document.body.innerHTML = '<div id="e"></div>';
    const timers = new FakeTimers();
    const fn = vi.fn((s: Record<string, unknown>) => ({ id: 1, ...s }));
    off.push(defineAct('note.create', {}, fn, { undo: () => {} }));
    const m = mount({ el: '#e', skill, timers, fonts: false });
    off.push(m.unmount);
    expect(document.querySelector('.entoli-bar')).not.toBeNull();
    expect(document.getElementById('entoli-css')).not.toBeNull();

    type('new note pick up keys');
    await flush();
    expect(document.querySelectorAll('.entoli-card')).toHaveLength(1);
    expect(document.querySelector('.entoli-card')!.getAttribute('data-phase')).toBe('hold');
    expect(document.querySelector('.entoli-said')!.textContent).toContain('new note pick up keys');
    expect(document.querySelector('.entoli-hold')).not.toBeNull();
    button('Not that')!.click();
    await timers.advance(2000);
    expect(fn).not.toHaveBeenCalled();

    type('new note pick up keys');
    await flush();
    await timers.advance(1600);
    expect(fn).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('.entoli-receipts li')).toHaveLength(1);
    expect(button('Undo')).toBeDefined();
  });

  it('exact card lists every argument and its yes carries the fingerprint', async () => {
    document.body.innerHTML = '<div id="e"></div>';
    const fn = vi.fn();
    off.push(defineAct('settings.email', {}, fn));
    const speech: SpeechProvider = { name: 'fake', supported: true, listen: async () => 'change my email to ana@example.com', stop() {}, speak: vi.fn() };
    const m = mount({ el: '#e', skill, mode: 'voice', speech, fonts: false });
    off.push(m.unmount);
    expect(document.querySelector('.entoli-mic')).not.toBeNull();
    await m.stage!.listen();
    await flush();
    const card = document.querySelector('.entoli-card')!;
    expect(card.getAttribute('data-phase')).toBe('exact');
    expect(card.querySelector('.entoli-args code')!.textContent).toBe('ana@example.com');
    const yes = button('Do exactly this')!;
    expect(yes.dataset.fingerprint).toBe(m.state.fingerprint);
    yes.click();
    await flush();
    expect(fn).toHaveBeenCalledWith({ email: 'ana@example.com' }, { channel: 'voice', act: 'settings.email' });
  });

  it('typing a voice-only act shows why it was refused', async () => {
    document.body.innerHTML = '<div id="e"></div>';
    off.push(defineAct('settings.email', {}, vi.fn()));
    const m = mount({ el: '#e', skill, fonts: false });
    off.push(m.unmount);
    type('change my email to a@b.c');
    await flush();
    expect(document.querySelector('.entoli-card')!.getAttribute('data-phase')).toBe('blocked');
    expect(document.querySelector('.entoli-card')!.textContent).toMatch(/voice only/i);
  });

  it('refuses an invalid skill at mount', () => {
    expect(() => mount({ skill: { entoli: '0.1' } })).toThrow(/Invalid entoli.skill.json/);
  });
});
