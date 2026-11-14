'use client';
/**
 * The always-on voice orb. Off by default: typing and one-at-a-time instructions
 * stay the normal way to work. One click turns the conversation on; one click
 * mutes; one click turns it off. A visible state and a real mute at all times.
 */
import { browserLive, getEntoli, openaiRealtime, startLive, type LiveProvider, type LiveSession, type LiveState } from '@entoli/sdk';
import { useEffect, useRef, useState } from 'react';

type Session = { provider: 'openai' | null; value?: string; model?: string; remainingSeconds: number; heartbeatSeconds?: number; error?: string };

export function LiveOrb({ appId, enabled, minutes, usedSeconds }: { appId: string; enabled: boolean; minutes: number; usedSeconds: number }) {
  const [state, setState] = useState<LiveState | 'off'>('off');
  const [note, setNote] = useState('');
  const live = useRef<LiveSession | null>(null);
  const beat = useRef<ReturnType<typeof setInterval> | null>(null);
  const since = useRef(0);

  const cleanup = () => {
    if (beat.current) { clearInterval(beat.current); beat.current = null; }
    live.current = null;
  };
  useEffect(() => () => { live.current?.stop(); cleanup(); }, []);

  async function turnOn() {
    setNote('');
    const entoli = getEntoli();
    if (!entoli) { setNote('The bar is not ready yet.'); return; }
    setState('connecting');
    try {
      const res = await fetch('/api/voice/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId }) });
      const s = (await res.json().catch(() => ({}))) as Session;
      if (!res.ok) throw new Error(s.error ?? `HTTP ${res.status}`);

      // The realtime provider when the server has one; the browser's own recognition otherwise.
      let provider: LiveProvider;
      if (s.provider === 'openai' && s.value) {
        provider = openaiRealtime({ getSecret: async () => ({ value: s.value!, ...(s.model ? { model: s.model } : {}) }) });
      } else {
        const b = browserLive();
        if (!b.supported) throw new Error('No voice provider is configured and this browser cannot listen continuously.');
        provider = b;
        setNote('Using your browser\'s speech recognition (no voice provider configured).');
      }

      since.current = Date.now();
      let stopped = false;
      const session = await startLive(entoli, provider, {
        onState: (st) => { setState(st); if (st === 'stopped') { stopped = true; cleanup(); } },
        onError: (e) => setNote(e.message),
        maxMs: (s.remainingSeconds ? Math.min(s.remainingSeconds, 30 * 60) : 30 * 60) * 1000,
      });
      live.current = session;
      // Meter the time: report every stretch, stop when the month's minutes run out.
      beat.current = setInterval(async () => {
        const seconds = Math.round((Date.now() - since.current) / 1000);
        since.current = Date.now();
        try {
          const r = await fetch('/api/voice/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, seconds }) });
          const b = (await r.json().catch(() => ({}))) as { stop?: boolean };
          if (b.stop && !stopped) { session.stop(); setNote('This month\'s live-voice minutes are used. Typing still works.'); }
        } catch { /* a missed beat is caught up in the next one */ }
      }, (s.heartbeatSeconds ?? 30) * 1000);
    } catch (e) {
      setState('off');
      setNote((e as Error).message);
      cleanup();
    }
  }

  function turnOff() {
    live.current?.stop();
    cleanup();
    setState('off');
  }

  const on = state !== 'off' && state !== 'stopped';
  const label: Record<string, string> = { off: 'Live voice off', connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking', muted: 'Muted', stopped: 'Live voice off' };
  const left = Math.max(0, minutes - Math.round(usedSeconds / 60));

  if (!enabled) return null;
  return (
    <div className="orb-wrap">
      <button
        type="button"
        className={`orb ${on ? state : 'off'}`}
        aria-pressed={on}
        aria-label={on ? 'Turn live voice off' : 'Turn live voice on'}
        onClick={() => (on ? turnOff() : void turnOn())}
        disabled={state === 'connecting'}
      >
        <i /><i /><i /><i /><i />
      </button>
      <span className="orb-label" role="status">{label[state]}{!on ? ` · ${left} min left` : ''}</span>
      {on ? <button type="button" className="btn small" onClick={() => (state === 'muted' ? live.current?.unmute() : live.current?.mute())}>{state === 'muted' ? 'Unmute' : 'Mute'}</button> : null}
      {note ? <span className="orb-note">{note}</span> : null}
    </div>
  );
}
