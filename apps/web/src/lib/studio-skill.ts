/** The dashboard's own skill (the voice tool). Client-safe: no server imports. */
import { validateSkill, type Skill } from '@entoli/sdk/skill';

const TABS = ['analyze', 'map', 'knowledge', 'skill', 'keys', 'usage', 'billing', 'integrate', 'test'];

export const STUDIO_SKILL: Skill = {
  entoli: '0.1',
  app: { name: 'Entoli dashboard' },
  layer: 'L2',
  mode: 'voice',
  map: TABS.map((t) => ({ id: `tab.${t}`, kind: 'screen' as const, title: t.charAt(0).toUpperCase() + t.slice(1), path: `/dashboard/apps/:id/${t}` })),
  knowledge: [
    { topic: 'integrate by voice', can: true, answer: 'Yes. Say "integrate new note and search, by voice". I prepare the changes; you approve each one; then say "open the pull request".', phrases: ['voice tool', 'speak my app', 'without typing'] },
    { topic: 'write code', can: true, answer: 'Yes, as a pull request. Every change is shown as a diff and goes in only if you approve it.' },
    { topic: 'change my code without asking', can: false, answer: 'No. Nothing reaches your repository until you approve the changes and say "open the pull request".', phrases: ['push to main', 'commit directly'] },
    { topic: 'claude code cursor', can: true, answer: 'Yes. On the Skill tab, download the skill for Claude Code, Cursor or AGENTS.md; your agent can wire it.', phrases: ['coding agent', 'export the skill'] },
    { topic: 'layer', can: true, answer: 'Yes. Say "set search to layer one" or "turn email off". L2: the AI answers. L1: device only. Off: not connected.', phrases: ['layers', 'per feature'] },
  ],
  acts: [
    { name: 'studio.go', title: 'Open a tab', phrases: ['go to', 'open', 'show me', 'take me to'], radius: 'self', undo: true,
      slots: { tab: { type: 'choice', required: true, label: 'Tab', options: TABS.map((t) => ({ value: t, ...(t === 'integrate' ? { label: 'integration', aliases: ['guided integration'] } : {}), ...(t === 'test' ? { aliases: ['tests', 'tester'] } : {}) })) } } },
    { name: 'studio.analyze', title: 'Analyze the repository', phrases: ['analyze', 'analyse', 'scan my repo', 'read my code', 'map my app'], radius: 'self',
      slots: {} },
    { name: 'studio.integrate', title: 'Prepare the integration', phrases: ['integrate', 'prepare the integration', 'wire up', 'expose'], radius: 'self',
      slots: {
        features: { type: 'freeText', label: 'Features', prompt: 'Which features? Say "all" or name them.' },
        layer: { type: 'choice', label: 'Default layer', options: [{ value: 'L2', aliases: ['layer two', 'layer 2', 'with ai'] }, { value: 'L1', aliases: ['layer one', 'layer 1', 'no ai', 'device only'] }] },
        mode: { type: 'choice', label: 'Mode', options: [{ value: 'voice', aliases: ['by voice', 'spoken'] }, { value: 'text', aliases: ['text only', 'typed'] }] },
        settingsBy: { type: 'choice', label: 'Settings by', options: [{ value: 'admins', aliases: ['admins only', 'admin'] }, { value: 'anyone' }, { value: 'nobody', aliases: ['no one', 'none'] }] },
      } },
    { name: 'studio.approve', title: 'Approve a change', phrases: ['approve', 'accept', 'keep'], radius: 'self', undo: true,
      slots: { change: { type: 'choice', required: true, label: 'Change', prompt: 'Which change?' } } },
    { name: 'studio.reject', title: 'Reject a change', phrases: ['reject', 'drop', 'discard'], radius: 'self', undo: true,
      slots: { change: { type: 'choice', required: true, label: 'Change', prompt: 'Which change?' } } },
    { name: 'studio.approveAll', title: 'Approve every change', phrases: ['approve all', 'approve everything', 'accept all'], radius: 'self', undo: true, slots: {} },
    { name: 'studio.layer', title: 'Set a feature\'s layer', phrases: ['set layer', 'turn off', 'move to layer'], radius: 'self', undo: true, kind: 'setting',
      slots: {
        act: { type: 'choice', required: true, label: 'Feature', prompt: 'Which feature?' },
        layer: { type: 'choice', required: true, label: 'Layer', options: [{ value: 'L2', aliases: ['layer two', 'layer 2', 'ai'] }, { value: 'L1', aliases: ['layer one', 'layer 1', 'device'] }, { value: 'off', aliases: ['disconnect', 'not connected'] }] },
      } },
    { name: 'studio.publish', title: 'Publish the skill', phrases: ['publish', 'go live', 'publish the skill'], radius: 'external', exact: true,
      slots: { app: { type: 'freeText', label: 'App' } } },
    { name: 'studio.openPr', title: 'Open the pull request', phrases: ['open the pull request', 'open a pr', 'create the pull request', 'ship it'], radius: 'external', exact: true,
      slots: { repo: { type: 'freeText', label: 'Repository' }, changes: { type: 'freeText', label: 'Approved changes' } } },
  ],
};

{
  const v = validateSkill(STUDIO_SKILL);
  if (!v.ok) throw new Error(`studio skill invalid: ${v.errors.join('; ')}`);
}

/** "new note and search" → act names, by title/name words. "all" or nothing → every act. */
export function pickFeatures(said: string, acts: { name: string; title?: string }[]): string[] {
  const t = said.toLowerCase().trim();
  if (!t || /\b(all|everything|every feature)\b/.test(t)) return acts.map((a) => a.name);
  const parts = t.split(/,|\band\b|\bplus\b/).map((p) => p.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    const words = p.split(/\s+/).filter((w) => w.length > 2);
    let best: { name: string; score: number } | null = null;
    for (const a of acts) {
      const hay = `${a.title ?? ''} ${a.name.replace(/[._-]/g, ' ')}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length / Math.max(1, words.length);
      if (score > 0 && (!best || score > best.score)) best = { name: a.name, score };
    }
    if (best) out.add(best.name);
  }
  return [...out];
}
