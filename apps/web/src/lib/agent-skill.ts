/**
 * Export the skill for a coding agent (Claude Code, Cursor, or any agent that
 * reads AGENTS.md). The developer drops one file in their repository and asks
 * their agent to "integrate Entoli": the file carries the skill itself, where
 * each act lives in their code, and exact wiring instructions.
 */
import { actLayer, type Skill } from '@entoli/sdk/skill';

export type AgentFormat = 'claude' | 'cursor' | 'agents';

export const AGENT_FILES: Record<AgentFormat, { path: string; label: string }> = {
  claude: { path: '.claude/skills/entoli/SKILL.md', label: 'Claude Code skill' },
  cursor: { path: '.cursor/rules/entoli.mdc', label: 'Cursor rule' },
  agents: { path: 'AGENTS.md (section)', label: 'AGENTS.md, for other agents' },
};

type Sources = Record<string, { file: string; line: number; component?: string; handler?: string }[]>;

function slotsLiteral(slots: NonNullable<Skill['acts'][number]['slots']>): string {
  const entries = Object.entries(slots).map(([k, v]) => `${k}: '${v.type}'`);
  return `{ ${entries.join(', ')} }`;
}

function body(skill: Skill, sources: Sources): string {
  const wired = skill.acts.filter((a) => actLayer(skill, a) !== 'off');
  const off = skill.acts.filter((a) => actLayer(skill, a) === 'off');
  const rows = wired.map((a) => {
    const where = sources[a.name]?.[0];
    const opts = [
      a.undo ? 'undo: (result, slots) => /* reverse it with existing state */' : null,
      a.radius !== 'self' ? `radius: '${a.radius}'` : null,
      a.exact ? 'exact: true' : null,
      a.voiceOnly ? 'voiceOnly: true' : null,
    ].filter(Boolean);
    return [
      `### \`${a.name}\` — ${a.title ?? a.name}`,
      `- Layer: ${actLayer(skill, a)}${actLayer(skill, a) === 'L2' ? ' (Entoli AI may pick it)' : ' (device only, no AI)'} · radius: ${a.radius} · ${a.undo ? 'can be undone' : 'no undo'}${a.kind === 'setting' ? ' · setting (always asks for a yes)' : ''}`,
      where ? `- In the code: \`${where.file}:${where.line}\`${where.component ? ` in \`${where.component}\`` : ''}${where.handler ? `, handler \`${where.handler}\`` : ''}` : '- In the code: not located by the analysis; find the function that does this.',
      '```tsx',
      `useEntoli('${a.name}', ${slotsLiteral(a.slots ?? {})}, (slots) => /* call the existing function */, { ${opts.join(', ')} });`,
      '```',
    ].join('\n');
  });
  return `# Integrate Entoli into this app

Entoli makes this app operable by intent, typed or spoken. The app already does everything; you only connect each act below to the function that already does it. Do not add capabilities.

## Steps
1. \`npm i @entoli/sdk\`
2. Save the skill below as \`entoli.skill.json\` next to \`package.json\`.
3. Mount once, at the app's entry:
   \`\`\`ts
   import { mount } from '@entoli/sdk';
   import skill from './entoli.skill.json';
   mount({ el: document.body.appendChild(document.createElement('div')), skill, mode: '${skill.mode}'${skill.layer === 'L2' || skill.acts.some((a) => a.layer === 'L2') ? ", key: import.meta.env.VITE_ENTOLI_KEY /* public app key, from the Entoli dashboard */" : ''} });
   \`\`\`
   (Next.js: mount inside a \`'use client'\` component with \`useEffect\`, and render it in the root layout.)
4. In each component that owns an act's function, add \`useEntoli\` from \`@entoli/sdk/react\` (plain JS: \`defineAct\` from \`@entoli/sdk\`, same arguments).
5. Run the app, type one phrase per act, and check the card appears.

## Rules
- Call the component's EXISTING function in the handler. Return what undo needs.
- Declare \`undo\` only when the component can genuinely reverse the action.
- Keep \`radius\`, \`exact\` and \`voiceOnly\` as listed: they decide what runs after a short hold and what waits for a yes.
- Slot values: \`quantity\` arrives as \`{ n, label }\`, \`when\` as \`{ at, label }\`, the others as strings.
- Do not wire acts marked off.

## Acts to wire (${wired.length})
${rows.join('\n\n')}
${off.length ? `\n## Not connected (layer "off"): leave manual\n${off.map((a) => `- \`${a.name}\``).join('\n')}\n` : ''}
## The skill (entoli.skill.json)
\`\`\`json
${JSON.stringify(skill, null, 2)}
\`\`\`
`;
}

export function agentSkillFile(skill: Skill, sources: Sources, format: AgentFormat): { filename: string; content: string } {
  const text = body(skill, sources);
  if (format === 'claude') {
    return {
      filename: 'SKILL.md',
      content: `---\nname: entoli-integration\ndescription: Integrate Entoli into ${skill.app.name} so it can be operated by intent (typed or spoken). Use when asked to add Entoli, voice control, or intent control to this app, or to wire entoli.skill.json.\n---\n\n${text}`,
    };
  }
  if (format === 'cursor') {
    return { filename: 'entoli.mdc', content: `---\ndescription: Integrate Entoli (intent and voice control) into ${skill.app.name}\nglobs:\nalwaysApply: false\n---\n\n${text}` };
  }
  return { filename: 'AGENTS-entoli.md', content: text };
}
