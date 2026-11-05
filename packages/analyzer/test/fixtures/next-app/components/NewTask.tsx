'use client';
import { useState } from 'react';

export function NewTask() {
  const [title, setTitle] = useState('');
  function addTask() { setTitle(''); }
  return (
    <div>
      <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input type="date" name="due" onChange={() => {}} />
      <button onClick={addTask}>Add task</button>
    </div>
  );
}
