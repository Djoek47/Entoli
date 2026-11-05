import { mount } from '@entoli/sdk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import skill from '../entoli.skill.json';
import { App } from './App.js';
import './styles.css';

const dock = document.createElement('div');
dock.id = 'entoli-dock';
document.body.append(dock);

const key = import.meta.env.VITE_ENTOLI_KEY as string | undefined;
const endpoint = import.meta.env.VITE_ENTOLI_ENDPOINT as string | undefined;

// Voice when the browser can listen; typing always works.
const entoli = mount({
  el: dock,
  skill,
  mode: 'voice',
  fonts: false,
  placeholder: 'Ask Fieldnotes: “new note…”, “search for…”',
  ...(key ? { key } : {}),
  ...(endpoint ? { endpoint } : {}),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App onExample={(t) => void entoli.hear(t)} />
  </StrictMode>,
);
