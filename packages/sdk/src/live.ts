/**
 * Always-on voice conversation.
 *
 * The provider is ears and mouth: it hears the person, hands over transcripts,
 * and says whatever it is told. It never decides anything. Every transcript
 * goes through Entoli.hear(), so the commit contract is unchanged: holds, a
 * yes, and "Do exactly this" bound to a fingerprint all apply to spoken input
 * exactly as to typed input.
 */

import type { Entoli, StageState } from './runtime.js';

export type LiveState = 'connecting' | 'listening' | 'speaking' | 'muted' | 'stopped';

export type LiveHandlers = {
  /** A finished utterance from the person. */
  onTranscript(text: string): void;
  /** The person started talking (barge-in). */
  onSpeechStart(): void;
  onError(e: Error): void;
};

export interface LiveProvider {
  readonly name: string;
  start(h: LiveHandlers): Promise<void>;
  /** Say this aloud, exactly. */
  say(text: string): void;
  /** Stop talking now. */
  interrupt(): void;
  setMuted(muted: boolean): void;
  stop(): void;
}

export type LiveOptions = {
  onState?: (s: LiveState) => void;
  onError?: (e: Error) => void;
  /** Stop after this long with nothing heard (cost control). Default 5 minutes. */
  idleMs?: number;
  /** Hard cap on one session. Default 30 minutes. */
  maxMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void; now(): number };
};

export type LiveSession = {
  readonly state: LiveState;
  mute(): void;
  unmute(): void;
  stop(): void;
};

/** What to say for a Stage state, or undefined for nothing. Pure, so it is tested alone. */
export function spokenFor(s: StageState): string | undefined {
  const clip = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 400);
  switch (s.phase) {
    case 'hold':
      return clip(s.reply ?? `${s.title ?? 'Doing it'}. Say no to stop.`);
    case 'confirm':
      return clip(`${s.reply ?? s.title ?? 'This'}. Say yes to go ahead, or no.`);
    case 'exact': {
      const args = (s.args ?? []).map((a) => `${a.label}: ${a.display}`).join('. ');
      return clip(`Exactly this. ${s.title ?? ''}. ${args}. Say yes to do exactly this, or no.`);
    }
    case 'ask':
      return s.ask ? clip(s.ask.prompt + (s.ask.options?.length ? ` ${s.ask.options.join(', or ')}?` : '')) : undefined;
    case 'narrow':
      return clip(`Which one? ${(s.choices ?? []).map((c) => c.title).join(', or ')}?`);
    case 'answer':
    case 'done':
    case 'error':
    case 'blocked':
    case 'none':
      return s.message ? clip(s.message) : undefined;
    default:
      return undefined;
  }
}

const realTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export async function startLive(entoli: Entoli, provider: LiveProvider, opts: LiveOptions = {}): Promise<LiveSession> {
  const timers = opts.timers ?? realTimers;
  let state: LiveState = 'connecting';
  let muted = false;
  let lastSpoken = '';
  let idle: unknown = null;
  let cap: unknown = null;
  let unsub: (() => void) | null = null;

  const set = (s: LiveState) => { if (state !== s) { state = s; opts.onState?.(s); } };
  const resetIdle = () => {
    if (idle !== null) timers.clear(idle);
    idle = timers.set(() => stop(), opts.idleMs ?? 5 * 60_000);
  };
  const speak = (text: string | undefined) => {
    if (!text || text === lastSpoken || state === 'stopped') return;
    lastSpoken = text;
    if (!muted) { set('speaking'); provider.say(text); }
  };
  const stop = () => {
    if (state === 'stopped') return;
    if (idle !== null) timers.clear(idle);
    if (cap !== null) timers.clear(cap);
    unsub?.();
    provider.stop();
    set('stopped');
  };

  // Outcomes that arrive on their own (a held action completing, an AI reply) are spoken too.
  // The first emission is the current state, which is not news.
  let first = true;
  unsub = entoli.subscribe((s) => {
    if (first) { first = false; return; }
    if (state === 'stopped') return;
    speak(spokenFor(s));
  });

  await provider.start({
    onTranscript(text) {
      const said = text.trim();
      if (!said || state === 'stopped') return;
      resetIdle();
      lastSpoken = ''; // a new turn: the same reply may be said again
      set('listening');
      void entoli.hear(said, { channel: 'voice' }).catch((e: Error) => opts.onError?.(e));
    },
    onSpeechStart() {
      if (state === 'stopped') return;
      resetIdle();
      provider.interrupt();
      if (state === 'speaking') set('listening');
    },
    onError(e) { opts.onError?.(e); stop(); },
  });
  set(muted ? 'muted' : 'listening');
  resetIdle();
  cap = timers.set(() => stop(), opts.maxMs ?? 30 * 60_000);

  return {
    get state() { return state; },
    mute() { muted = true; provider.interrupt(); provider.setMuted(true); set('muted'); },
    unmute() { muted = false; provider.setMuted(false); set('listening'); },
    stop,
  };
}

// ---- OpenAI Realtime over WebRTC ---------------------------------------------------------

export type RealtimeSecret = { value: string; model?: string };

type DataChannelLike = { send(data: string): void; onmessage: ((e: { data: string }) => void) | null; onopen: (() => void) | null; readyState?: string };
type PeerLike = {
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<{ sdp?: string }>;
  setLocalDescription(d: { sdp?: string; type?: string }): Promise<void>;
  setRemoteDescription(d: { type: string; sdp: string }): Promise<void>;
  addTrack(track: unknown, stream: unknown): unknown;
  ontrack: ((e: { streams: unknown[] }) => void) | null;
  close(): void;
};

export type OpenAIRealtimeDeps = {
  /** Asks OUR server for a short-lived key. The real OpenAI key never reaches the browser. */
  getSecret: () => Promise<RealtimeSecret>;
  fetch?: typeof fetch;
  createPeer?: () => PeerLike;
  getUserMedia?: () => Promise<{ getTracks(): { enabled: boolean; stop(): void }[] }>;
  createAudio?: () => { srcObject: unknown; autoplay: boolean; muted?: boolean };
};

/**
 * Session settings are fixed when the server mints the key (no auto-responses:
 * the model must not answer on its own, only say what Entoli gives it).
 */
export function openaiRealtime(deps: OpenAIRealtimeDeps): LiveProvider {
  let pc: PeerLike | null = null;
  let dc: DataChannelLike | null = null;
  let stream: { getTracks(): { enabled: boolean; stop(): void }[] } | null = null;
  let audio: { srcObject: unknown } | null = null;
  const send = (o: object) => { if (dc) dc.send(JSON.stringify(o)); };

  return {
    name: 'openai-realtime',
    async start(h) {
      const secret = await deps.getSecret();
      const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
      pc = deps.createPeer ? deps.createPeer() : (new (globalThis as unknown as { RTCPeerConnection: new () => PeerLike }).RTCPeerConnection());
      const el = deps.createAudio ? deps.createAudio() : Object.assign(document.createElement('audio'), { autoplay: true });
      el.autoplay = true;
      audio = el;
      pc.ontrack = (e) => { el.srcObject = e.streams[0]; };
      stream = await (deps.getUserMedia ? deps.getUserMedia() : navigator.mediaDevices.getUserMedia({ audio: true }));
      for (const t of stream.getTracks()) pc.addTrack(t, stream);
      dc = pc.createDataChannel('oai-events');
      dc.onmessage = (e) => {
        let ev: { type?: string; transcript?: string; error?: { message?: string } };
        try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) h.onTranscript(ev.transcript);
        else if (ev.type === 'input_audio_buffer.speech_started') h.onSpeechStart();
        else if (ev.type === 'error') h.onError(new Error(ev.error?.message ?? 'realtime error'));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await f(`https://api.openai.com/v1/realtime/calls${secret.model ? `?model=${encodeURIComponent(secret.model)}` : ''}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret.value}`, 'content-type': 'application/sdp' },
        body: offer.sdp ?? '',
      });
      if (!res.ok) throw new Error(`Realtime connection refused (HTTP ${res.status})`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    },
    say(text) {
      send({ type: 'response.create', response: { instructions: `Say exactly the following words, and nothing else: ${text}` } });
    },
    interrupt() {
      send({ type: 'response.cancel' });
      send({ type: 'output_audio_buffer.clear' });
    },
    setMuted(m) { for (const t of stream?.getTracks() ?? []) t.enabled = !m; },
    stop() {
      for (const t of stream?.getTracks() ?? []) t.stop();
      pc?.close();
      if (audio) audio.srcObject = null;
      pc = null; dc = null; stream = null;
    },
  };
}

// ---- Browser continuous recognition (no account needed) -----------------------------------

type RecLike = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onspeechstart?: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort?(): void;
};

export function browserLive(win: unknown = typeof window !== 'undefined' ? window : undefined, lang = 'en-US'): LiveProvider & { supported: boolean } {
  const w = win as { SpeechRecognition?: new () => RecLike; webkitSpeechRecognition?: new () => RecLike; speechSynthesis?: { speak(u: unknown): void; cancel(): void }; SpeechSynthesisUtterance?: new (t: string) => { lang: string } } | undefined;
  const Ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  let rec: RecLike | null = null;
  let running = false;
  let muted = false;

  const begin = () => {
    if (!Ctor || !running || muted) return;
    rec = new Ctor();
    rec.lang = lang; rec.continuous = true; rec.interimResults = false;
    rec.start();
  };

  return {
    name: 'browser-continuous',
    supported: !!Ctor,
    async start(h) {
      if (!Ctor) throw new Error('Speech recognition is not available in this browser');
      running = true;
      const wire = () => {
        if (!rec) return;
        rec.onresult = (e) => {
          h.onSpeechStart();
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]!;
            if (r.isFinal) h.onTranscript(r[0]!.transcript);
          }
        };
        rec.onspeechstart = () => h.onSpeechStart();
        rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') h.onError(new Error(e.error)); };
        // Browsers end recognition on silence: keep it open while the session is on.
        rec.onend = () => { if (running && !muted) { begin(); wire(); } };
      };
      begin();
      wire();
    },
    say(text) {
      if (!w?.speechSynthesis || !w.SpeechSynthesisUtterance) return;
      const u = new w.SpeechSynthesisUtterance(text);
      u.lang = lang;
      w.speechSynthesis.speak(u);
    },
    interrupt() { w?.speechSynthesis?.cancel(); },
    setMuted(m) {
      muted = m;
      if (m) { rec?.stop(); rec = null; }
      else if (running) { begin(); }
    },
    stop() { running = false; rec?.stop(); rec = null; w?.speechSynthesis?.cancel(); },
  };
}
