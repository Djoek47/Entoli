/**
 * Knowledge answers: "can it export to PDF?"
 *
 * Answers come only from skill.knowledge. When nothing there matches, the
 * answer says so; it never guesses what the app can do.
 */

import { mood } from './engine/mood.js';
import { normalize, similarity, TOKEN_FLOOR } from './engine/text.js';
import type { KnowledgeEntry } from './skill.js';

const STOP = new Set([
  'a', 'an', 'the', 'it', 'i', 'you', 'can', 'could', 'does', 'do', 'is', 'are', 'there', 'way', 'to', 'my', 'me', 'this', 'app',
  'how', 'will', 'be', 'able', 'of', 'in', 'on', 'for', 'with', 'as', 'and', 'or', 'any', 'what', 'about', 'support', 'supports', 'please',
]);

function content(s: string): string[] {
  return normalize(s).split(' ').filter((w) => w && !STOP.has(w));
}

const ASKS_ABOUT = /^(can|could|does|do|is|are|will|how)\b|\b(can it|does it|is there|how do i|how can i|am i able)\b/;

/** A question about what the app can do, rather than a request to do it. */
export function isKnowledgeQuestion(text: string): boolean {
  if (mood(text) !== 'question') return false;
  return ASKS_ABOUT.test(normalize(text.replace(/[’'-]/g, ' ')));
}

export type KnowledgeAnswer = { entry: KnowledgeEntry; score: number };

export function answerFrom(knowledge: KnowledgeEntry[], question: string, floor = 0.6): KnowledgeAnswer | null {
  const q = content(question);
  if (q.length === 0) return null;
  let best: KnowledgeAnswer | null = null;
  for (const entry of knowledge) {
    for (const needle of [entry.topic, ...(entry.phrases ?? [])]) {
      const words = content(needle);
      if (words.length === 0) continue;
      let hit = 0;
      for (const w of words) {
        let s = 0;
        for (const t of q) s = Math.max(s, similarity(t, w));
        if (s >= TOKEN_FLOOR) hit += s;
      }
      const score = hit / words.length;
      if (score >= floor && (!best || score > best.score)) best = { entry, score };
    }
  }
  return best;
}

export const NO_KNOWLEDGE = "I don't know. That isn't in what this app has told me about itself.";
