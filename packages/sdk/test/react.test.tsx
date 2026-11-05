// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '../src/index.js';
import { useEntoli, useStage } from '../src/react.js';
import { skill, FakeTimers } from './fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function Notes() {
  const [notes, setNotes] = useState<string[]>([]);
  useEntoli('note.create', { text: 'freeText' }, ({ text }) => { setNotes((n) => [...n, String(text)]); return String(text); }, {
    undo: (t) => setNotes((n) => n.filter((x) => x !== t)),
  });
  const stage = useStage();
  return <div><ul>{notes.map((n) => <li key={n}>{n}</li>)}</ul><p id="phase">{stage?.phase}</p></div>;
}

describe('useEntoli', () => {
  it('wires a component function; undo restores state; unmount unregisters', async () => {
    const timers = new FakeTimers();
    const e = mount({ skill, timers });
    cleanup.push(e.unmount);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Notes />));
    expect(e.registered()).toContain('note.create');

    await act(async () => { await e.hear('new note water plants'); });
    expect(host.querySelector('#phase')!.textContent).toBe('hold');
    await act(async () => { await timers.advance(1600); });
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.querySelector('#phase')!.textContent).toBe('done');

    await act(async () => { await e.undo(e.state.receipts[0]!.id); });
    expect(host.querySelectorAll('li')).toHaveLength(0);

    await act(async () => root.unmount());
    expect(e.registered()).not.toContain('note.create');
  });
});
