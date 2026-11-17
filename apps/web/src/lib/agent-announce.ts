/**
 * What the live conversation says when the developer's own coding agent does
 * something ("Your agent wired Search. It is waiting for your approval.").
 * Pure: it turns events into one short sentence.
 */
export type AgentEventLike = { id: string; kind: string; act: string | null; status: string | null; note: string | null; createdAt: Date | string };

const pretty = (act: string | null) => (act ?? 'a feature').replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function line(e: AgentEventLike): string | null {
  const note = (e.note ?? '').replace(/\s+/g, ' ').trim();
  if (e.kind === 'progress' && e.status === 'wired') return `Your agent wired ${pretty(e.act)}.`;
  if (e.kind === 'progress' && e.status === 'blocked') return `Your agent is blocked on ${pretty(e.act)}${note ? `: ${note}` : '.'}`;
  if (e.kind === 'submit') {
    const [file, ...rest] = note.split(': ');
    return `Your agent ${e.status === 'revised' ? 'revised' : 'submitted'} a change to ${file}${rest.length ? `: ${rest.join(': ')}` : ''}. It is waiting for your approval.`;
  }
  if (e.kind === 'refused') return `The guardrails stopped your agent${note ? `: ${note}` : '.'}`;
  return null; // "started" is noise in a conversation
}

/** Events oldest-first or newest-first, in any order: one announcement, at most three sentences, or null. */
export function announce(events: AgentEventLike[]): { text: string; latest: string } | null {
  const sorted = [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const lines = sorted.map(line).filter((l): l is string => !!l);
  if (!lines.length) return null;
  const shown = lines.slice(0, 3);
  const more = lines.length - shown.length;
  return { text: `${shown.join(' ')}${more > 0 ? ` And ${more} more update${more > 1 ? 's' : ''}.` : ''}`.slice(0, 400), latest: new Date(sorted.at(-1)!.createdAt).toISOString() };
}
