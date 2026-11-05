import { useState } from 'react';

export function NotesPage() {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const handleCreateNote = (e: { preventDefault(): void }) => { e.preventDefault(); setNotes([...notes, text]); };
  const deleteNote = (i: number) => setNotes(notes.filter((_, j) => j !== i));
  const shareNote = (i: number) => fetch('/api/share', { method: 'POST', body: String(i) });
  return (
    <main>
      <form onSubmit={handleCreateNote}>
        <input name="text" placeholder="Write a note" value={text} onChange={(e) => setText(e.target.value)} required />
        <select name="tag">
          <option value="work">Work</option>
          <option value="home">Home</option>
        </select>
        <button type="submit">Add note</button>
      </form>
      {notes.map((n, i) => (
        <div key={i}>
          {n}
          <button data-testid="delete" onClick={() => deleteNote(i)}>Delete</button>
          <button onClick={() => shareNote(i)} aria-label="Share with a friend">↗</button>
        </div>
      ))}
    </main>
  );
}
