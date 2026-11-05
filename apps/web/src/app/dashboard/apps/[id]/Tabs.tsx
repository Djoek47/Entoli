'use client';
import { usePathname } from 'next/navigation';

export const TABS = [
  ['analyze', 'Analyze'], ['map', 'Map'], ['knowledge', 'Knowledge'], ['skill', 'Skill'], ['keys', 'Keys'],
  ['usage', 'Usage'], ['billing', 'Billing'], ['integrate', 'Guided integration'], ['test', 'Test'],
] as const;

export function Tabs({ id }: { id: string }) {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="App sections">
      {TABS.map(([slug, label]) => {
        const href = `/dashboard/apps/${id}/${slug}`;
        return <a key={slug} href={href} aria-current={path?.startsWith(href) ? 'page' : undefined}>{label}</a>;
      })}
    </nav>
  );
}
