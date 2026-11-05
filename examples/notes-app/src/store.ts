import { useEffect, useState } from 'react';

export const TAGS = ['work', 'personal', 'ideas', 'urgent'] as const;
export type Tag = (typeof TAGS)[number];

export type Note = { id: string; text: string; tags: Tag[]; at: number };
export type Settings = { theme: 'light' | 'dark'; fontSize: number; email: string };

export const DEFAULT_SETTINGS: Settings = { theme: 'light', fontSize: 16, email: 'you@example.com' };

const SEED: Note[] = [
  { id: 'n1', text: 'Call the bank about the card replacement', tags: ['urgent'], at: Date.now() - 86_400_000 },
  { id: 'n2', text: 'Idea: a reading list that sorts itself by mood', tags: ['ideas'], at: Date.now() - 3_600_000 },
  { id: 'n3', text: 'Buy milk, eggs and coffee', tags: ['personal'], at: Date.now() - 600_000 },
];

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function usePersisted<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [v, set] = useState<T>(() => load(key, fallback));
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
  }, [key, v]);
  return [v, set];
}

export const seedNotes = () => SEED;

let n = 0;
export const newId = () => `n${Date.now().toString(36)}${(n++).toString(36)}`;

/** Spoken addresses arrive as words: "ana at example dot com". */
export function normaliseEmail(raw: string): string {
  return raw
    .trim()
    .replace(/^to\s+/i, '')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '')
    .replace(/[.,;!?]+$/, '')
    .toLowerCase();
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
