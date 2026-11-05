'use client';
/**
 * The dashboard's own Entoli bar. L2 plan: the voice tool (Entoli's AI answers
 * and drives the dashboard). Other plans: Layer 1, the device answers.
 */
import { defineAct, mount, type Mounted, type RemoteChoice } from '@entoli/sdk';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { changeStatusAction, openPrAction, publishSkillAction, setActLayerAction, startAnalysisAction, startIntegrationAction } from '../../actions';
import { pickFeatures, STUDIO_SKILL } from '@/lib/studio-skill';

export type StudioProps = {
  appId: string;
  appName: string;
  repo: string | null;
  voiceTool: boolean;
  voiceInput: boolean;
  quota: number;
  used: number;
  acts: { name: string; title: string; layer: string }[];
  integration: { id: string; changes: { id: string; title: string; file: string; status: string }[] } | null;
};

const form = (entries: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

export function StudioBar(props: StudioProps) {
  const el = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (!el.current) return;
    const p = () => live.current;
    const base = `/dashboard/apps/${props.appId}`;
    const refresh = () => router.refresh();
    const changeOptions = () => (p().integration?.changes ?? []).map((c) => ({ value: c.id, label: c.title, aliases: [c.file, c.file.split('/').pop() ?? ''] }));
    const offs = [
      defineAct('studio.go', { tab: 'choice' }, ({ tab }) => { const prev = pathRef.current; router.push(`${base}/${String(tab)}`); return prev; }, { undo: (prev) => router.push(String(prev)) }),
      defineAct('studio.analyze', {}, async () => { await startAnalysisAction(props.appId); }, { describe: () => `Analysis of ${p().repo ?? 'the repository'} started` }),
      defineAct('studio.integrate', { features: 'freeText', layer: 'choice', mode: 'choice', settingsBy: 'choice' }, async (s) => {
        await startIntegrationAction(props.appId, form({
          features: String(s.features).split(',').filter(Boolean), layer: String(s.layer), mode: String(s.mode),
          settingsBy: String(s.settingsBy), design: 'entoli', confirm: 'contract',
        }));
      }, {
        // Fill the defaults before the card, so it shows exactly what will be prepared.
        prepare: (s) => {
          const features = pickFeatures(typeof s.features === 'string' ? s.features : '', p().acts.filter((a) => a.layer !== 'off'));
          if (!features.length) return 'I could not match those features. Say "all", or name them as they appear in the Map tab.';
          return { features: features.join(','), layer: s.layer ?? (p().voiceTool ? 'L2' : 'L1'), mode: s.mode ?? 'voice', settingsBy: s.settingsBy ?? 'admins' };
        },
        describe: (s) => `Preparing the integration: ${String(s.features).split(',').length} features`,
      }),
      defineAct('studio.approve', { change: { type: 'choice', options: changeOptions } }, async ({ change }) => {
        const i = p().integration; if (!i) throw new Error('No prepared changes yet.');
        await changeStatusAction(props.appId, i.id, String(change), 'approved'); refresh(); return change;
      }, { undo: async (c) => { const i = p().integration; if (i) { await changeStatusAction(props.appId, i.id, String(c), 'pending'); refresh(); } } }),
      defineAct('studio.reject', { change: { type: 'choice', options: changeOptions } }, async ({ change }) => {
        const i = p().integration; if (!i) throw new Error('No prepared changes yet.');
        await changeStatusAction(props.appId, i.id, String(change), 'rejected'); refresh(); return change;
      }, { undo: async (c) => { const i = p().integration; if (i) { await changeStatusAction(props.appId, i.id, String(c), 'pending'); refresh(); } } }),
      defineAct('studio.approveAll', {}, async () => {
        const i = p().integration; if (!i) throw new Error('No prepared changes yet.');
        const pending = i.changes.filter((c) => c.status === 'pending').map((c) => c.id);
        for (const c of pending) await changeStatusAction(props.appId, i.id, c, 'approved');
        refresh(); return pending;
      }, { undo: async (ids) => { const i = p().integration; if (i) { for (const c of ids as string[]) await changeStatusAction(props.appId, i.id, c, 'pending'); refresh(); } } }),
      defineAct('studio.layer', { act: { type: 'choice', options: () => p().acts.map((a) => ({ value: a.name, label: a.title, aliases: [a.name] })) }, layer: 'choice' }, async ({ act, layer }) => {
        const prev = p().acts.find((a) => a.name === act)?.layer ?? 'L1';
        await setActLayerAction(props.appId, String(act), form({ layer: String(layer) })); refresh(); return prev;
      }, { undo: async (prev, s) => { await setActLayerAction(props.appId, String(s.act), form({ layer: String(prev) })); refresh(); } }),
      defineAct('studio.publish', { app: 'freeText' }, async () => {
        const r = await publishSkillAction(props.appId);
        if (!r.ok) throw new Error(r.message);
        refresh();
      }, { prepare: () => ({ app: p().appName }) }),
      defineAct('studio.openPr', { repo: 'freeText', changes: 'freeText' }, async () => {
        const i = p().integration; if (!i) throw new Error('No prepared changes yet.');
        await openPrAction(props.appId, i.id);
      }, {
        prepare: () => {
          const approved = p().integration?.changes.filter((c) => c.status === 'approved') ?? [];
          if (!approved.length) return 'Approve at least one change first. Say "approve all", or name a change.';
          return { repo: p().repo ?? '', changes: approved.map((c) => c.title).join('; ') };
        },
      }),
    ];

    const resolver = props.voiceTool
      ? async (req: object): Promise<RemoteChoice> => {
        const res = await fetch('/api/studio/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req, appId: props.appId }) });
        const body = await res.json().catch(() => ({})) as RemoteChoice & { error?: string };
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body;
      }
      : undefined;
    let m: Mounted | null = null;
    m = mount({
      el: el.current,
      skill: STUDIO_SKILL,
      layer: props.voiceTool ? 'L2' : 'L1',
      mode: props.voiceInput ? 'voice' : 'text',
      fonts: false,
      placeholder: props.voiceTool ? 'Speak or type: "analyze my repo", "integrate everything by voice"…' : 'Type: "go to map", "analyze"…',
      ...(resolver ? { resolver } : {}),
    });
    document.body.classList.add('has-studio');
    return () => { offs.forEach((off) => off()); m?.unmount(); document.body.classList.remove('has-studio'); };
    // Mounted once per app page; live data is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.appId, props.voiceTool, props.voiceInput]);

  return (
    <div className="studio-dock" aria-label="Entoli for this dashboard">
      <div ref={el} />
      <div className="studio-hint">{props.voiceTool ? `Voice tool · Layer 2 · ${props.used}/${props.quota} turns this month` : 'Layer 1 · the device answers · the voice tool is part of L2'}</div>
    </div>
  );
}
