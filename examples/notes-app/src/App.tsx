import { useEntoli } from '@entoli/sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SETTINGS, EMAIL, newId, normaliseEmail, seedNotes, TAGS, usePersisted, type Note, type Settings, type Tag } from './store.js';

type Screen = 'notes' | 'settings';

const EXAMPLES = [
  'new note book the dentist',
  'search for milk',
  'tag it work',
  'can it export to PDF?',
  'switch to dark mode',
  'set font size to 18',
  'go to settings',
];

function screenFromPath(): Screen {
  return typeof location !== 'undefined' && location.pathname.startsWith('/settings') ? 'settings' : 'notes';
}

export function App({ onExample }: { onExample?: (text: string) => void }) {
  const [notes, setNotes] = usePersisted<Note[]>('fieldnotes.notes', seedNotes());
  const [settings, setSettings] = usePersisted<Settings>('fieldnotes.settings', DEFAULT_SETTINGS);
  const [screen, setScreenState] = useState<Screen>(screenFromPath);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const setScreen = (s: Screen) => {
    setScreenState(s);
    if (typeof history !== 'undefined') history.pushState(null, '', s === 'settings' ? '/settings' : '/');
  };
  useEffect(() => {
    const on = () => setScreenState(screenFromPath());
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
  }, [settings.theme, settings.fontSize]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((n) => !q || n.text.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q))).sort((a, b) => b.at - a.at);
  }, [notes, query]);
  const current = notes.find((n) => n.id === selected) ?? visible[0] ?? null;

  // ---- The app's real functions, wired to Entoli ---------------------------

  const addNote = (text: string): Note => {
    const note: Note = { id: newId(), text: text.trim(), tags: [], at: Date.now() };
    setNotes((ns) => [note, ...ns]);
    setSelected(note.id);
    setScreen('notes');
    return note;
  };
  const removeNote = (id: string) => setNotes((ns) => ns.filter((n) => n.id !== id));
  const setTags = (id: string, tags: Tag[]) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, tags } : n)));

  useEntoli('note.create', { text: 'freeText' }, ({ text }) => addNote(String(text)), {
    undo: (note) => removeNote((note as Note).id),
    describe: ({ text }) => `New note “${String(text)}”`,
  });

  useEntoli('note.search', { query: 'freeText' }, ({ query: q }) => {
    const prev = query;
    setScreen('notes');
    setQuery(String(q));
    return prev;
  }, { undo: (prev) => setQuery(String(prev ?? '')), describe: ({ query: q }) => `Searched “${String(q)}”` });

  useEntoli('note.tag', { tag: 'choice' }, ({ tag }) => {
    if (!current) throw new Error('There is no note to tag. Make one first.');
    const prev = current.tags;
    const t = tag as Tag;
    setTags(current.id, prev.includes(t) ? prev : [...prev, t]);
    return { id: current.id, prev };
  }, {
    undo: (r) => { const { id, prev } = r as { id: string; prev: Tag[] }; setTags(id, prev); },
    describe: ({ tag }) => `Tagged “${current?.text.slice(0, 28) ?? ''}” ${String(tag)}`,
  });

  useEntoli('note.delete', {
    note: { type: 'choice', options: () => notes.map((n) => ({ value: n.id, label: n.text.slice(0, 40), aliases: n.text.split(/\s+/).filter((w) => w.length > 3).slice(0, 3) })) },
  }, ({ note }) => {
    const target = notes.find((n) => n.id === note) ?? current;
    if (!target) throw new Error('There is no note to delete.');
    removeNote(target.id);
    return target;
  }, {
    undo: (n) => setNotes((ns) => [n as Note, ...ns]),
    describe: ({ note }) => `Deleted “${(notes.find((n) => n.id === note) ?? current)?.text.slice(0, 32) ?? ''}”`,
  });

  useEntoli('nav.open', { screen: 'choice' }, ({ screen: s }) => {
    const prev = screen;
    setScreen(s === 'settings' ? 'settings' : 'notes');
    return prev;
  }, { undo: (prev) => setScreen(prev as Screen), describe: ({ screen: s }) => `Opened ${String(s)}` });

  useEntoli('settings.theme', { theme: 'choice' }, ({ theme }) => {
    const prev = settings.theme;
    setSettings((s) => ({ ...s, theme: theme === 'dark' ? 'dark' : 'light' }));
    return prev;
  }, { undo: (prev) => setSettings((s) => ({ ...s, theme: prev as Settings['theme'] })), describe: ({ theme }) => `Theme set to ${String(theme)}` });

  useEntoli('settings.fontSize', { size: 'quantity' }, ({ size }) => {
    const prev = settings.fontSize;
    setSettings((s) => ({ ...s, fontSize: Number(size) }));
    return prev;
  }, {
    prepare: ({ size }) => {
      const n = typeof size === 'object' && size ? Number((size as { n: number }).n) : Number(size);
      return n >= 12 && n <= 24 ? { size: n } : `Font size must be between 12 and 24 (heard ${Number.isFinite(n) ? n : 'nothing'}).`;
    },
    undo: (prev) => setSettings((s) => ({ ...s, fontSize: Number(prev) })),
    describe: ({ size }) => `Font size ${String(size)}px`,
  });

  // External, exact, voice only: the card shows the exact address and the yes covers only it.
  useEntoli('settings.email', { email: 'freeText' }, ({ email }) => {
    setSettings((s) => ({ ...s, email: String(email) }));
    setScreen('settings');
  }, {
    radius: 'external', exact: true, voiceOnly: true,
    prepare: ({ email }) => {
      const v = normaliseEmail(String(email));
      return EMAIL.test(v) ? { email: v } : `“${v}” is not an email address. Nothing changed.`;
    },
    describe: ({ email }) => `Email changed to ${String(email)}`,
  });

  // ---- UI -------------------------------------------------------------------

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); setScreen('notes'); }}>
          <span className="logo" aria-hidden>F</span> Fieldnotes
        </a>
        <nav aria-label="Main">
          <button className={screen === 'notes' ? 'on' : ''} onClick={() => setScreen('notes')} data-testid="nav-notes">Notes</button>
          <button className={screen === 'settings' ? 'on' : ''} onClick={() => setScreen('settings')} data-testid="nav-settings">Settings</button>
        </nav>
        <span className="powered">operable by intent · <b>Entoli</b></span>
      </header>

      {screen === 'notes' ? (
        <main data-screen="notes" className="notes">
          <form className="new" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { addNote(draft); setDraft(''); } }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a note…" aria-label="New note text" />
            <button type="submit" data-testid="new-note">New note</button>
          </form>
          <div className="tools">
            <input data-testid="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search notes" />
            {query && <button className="link" onClick={() => setQuery('')}>Clear</button>}
          </div>
          {visible.length === 0 ? (
            <p className="empty">{query ? `Nothing matches “${query}”.` : 'No notes yet. Say “new note …”.'}</p>
          ) : (
            <ul className="list">
              {visible.map((n) => (
                <li key={n.id} className={current?.id === n.id ? 'sel' : ''} onClick={() => setSelected(n.id)}>
                  <p>{n.text}</p>
                  <div className="meta">
                    {n.tags.map((t) => <span key={t} className={`tag t-${t}`}>{t}</span>)}
                    <time>{new Date(n.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                  </div>
                  {current?.id === n.id && (
                    <div className="row-actions">
                      <select data-testid="tag-menu" aria-label="Add tag" value="" onChange={(e) => { const t = e.target.value as Tag; if (t && !n.tags.includes(t)) setTags(n.id, [...n.tags, t]); }}>
                        <option value="">Tag…</option>
                        {TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button className="link danger" data-testid="delete-note" onClick={(e) => { e.stopPropagation(); removeNote(n.id); }}>Delete</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </main>
      ) : (
        <main data-screen="settings" className="settings">
          <h1>Settings</h1>
          <label className="field">
            <span>Theme</span>
            <select data-testid="theme" value={settings.theme} onChange={(e) => setSettings((s) => ({ ...s, theme: e.target.value as Settings['theme'] }))}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">
            <span>Font size <code>{settings.fontSize}px</code></span>
            <input data-testid="font-size" type="range" min={12} max={24} value={settings.fontSize} onChange={(e) => setSettings((s) => ({ ...s, fontSize: Number(e.target.value) }))} />
          </label>
          <div className="field">
            <span>Email</span>
            <code data-testid="email">{settings.email}</code>
            <small>Changing it reaches outside this app, so it is voice only and shows exactly the new address before you say yes.</small>
          </div>
        </main>
      )}

      <aside className="try" aria-label="Try saying">
        <span>Try</span>
        {EXAMPLES.map((x) => <button key={x} onClick={() => onExample?.(x)}>{x}</button>)}
      </aside>
    </div>
  );
}
