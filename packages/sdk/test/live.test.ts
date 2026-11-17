import { describe, expect, it, vi } from 'vitest';
import { browserLive, openaiRealtime, spokenFor, startLive, type LiveHandlers, type LiveProvider } from '../src/live.js';
import { Entoli } from '../src/runtime.js';
import { FakeTimers, skill } from './fixture.js';

function fakeProvider() {
  let h!: LiveHandlers;
  const log: string[] = [];
  const p: LiveProvider = {
    name: 'fake',
    async start(handlers) { h = handlers; log.push('start'); },
    say: (t) => log.push(`say:${t}`),
    interrupt: () => log.push('interrupt'),
    setMuted: (m) => log.push(`muted:${m}`),
    stop: () => log.push('stop'),
  };
  return { p, log, hear: (t: string) => h.onTranscript(t), talkOver: () => h.onSpeechStart(), fail: (e: Error) => h.onError(e) };
}

function setup(timers = new FakeTimers()) {
  const e = new Entoli({ skill, timers });
  const create = vi.fn(() => ({ id: 1 }));
  e.register('note.create', {}, create, { undo: () => {} });
  const email = vi.fn();
  e.register('settings.email', {}, email);
  e.register('settings.theme', {}, vi.fn(), { undo: () => {} });
  return { e, timers, create, email };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('spokenFor', () => {
  it('speaks each card the way it should be heard', () => {
    const base = { receipts: [] };
    expect(spokenFor({ ...base, phase: 'idle' })).toBeUndefined();
    expect(spokenFor({ ...base, phase: 'hold', title: 'New note', reply: 'Adding that.' })).toBe('Adding that.');
    expect(spokenFor({ ...base, phase: 'confirm', title: 'Change theme' })).toBe('Change theme. Say yes to go ahead, or no.');
    expect(spokenFor({ ...base, phase: 'exact', title: 'Change email', args: [{ name: 'email', label: 'New email', value: 'a@b.co', display: 'a@b.co' }] }))
      .toBe('Exactly this. Change email. New email: a@b.co. Say yes to do exactly this, or no.');
    expect(spokenFor({ ...base, phase: 'ask', ask: { slot: 'theme', prompt: 'Light or dark?', options: ['light', 'dark'] } })).toBe('Light or dark? light, or dark?');
    expect(spokenFor({ ...base, phase: 'done', message: 'Done: New note' })).toBe('Done: New note');
  });
});

describe('startLive', () => {
  it('a spoken request goes through the contract; the outcome of the hold is spoken when it lands', async () => {
    const { e, timers, create } = setup();
    const f = fakeProvider();
    const session = await startLive(e, f.p, { timers });
    expect(session.state).toBe('listening');
    f.hear('new note buy milk');
    await tick();
    expect(f.log).toContain('say:New note. Say no to stop.');
    expect(create).not.toHaveBeenCalled();
    await timers.advance(1600);
    expect(create).toHaveBeenCalled();
    expect(f.log.at(-1)).toMatch(/^say:Done: New note/);
  });

  it('spoken "yes" confirms the exact card it just read out, and nothing else', async () => {
    const { e, timers, email } = setup();
    const f = fakeProvider();
    await startLive(e, f.p, { timers });
    f.hear('change my email to ana at example dot com');
    await tick();
    expect(f.log.find((l) => l.startsWith('say:Exactly this'))).toContain('Change email'); // the card is read out before any yes counts
    expect(email).not.toHaveBeenCalled();
    f.hear('yes');
    await tick();
    expect(email).toHaveBeenCalledOnce();
  });

  it('talking over the reply interrupts it', async () => {
    const { e, timers } = setup();
    const f = fakeProvider();
    const s = await startLive(e, f.p, { timers });
    f.hear('can it export to pdf?');
    await tick();
    expect(s.state).toBe('speaking');
    f.talkOver();
    expect(f.log).toContain('interrupt');
    expect(s.state).toBe('listening');
  });

  it('mute stops listening and speaking; unmute resumes', async () => {
    const { e, timers } = setup();
    const f = fakeProvider();
    const s = await startLive(e, f.p, { timers });
    s.mute();
    expect(s.state).toBe('muted');
    expect(f.log).toEqual(expect.arrayContaining(['interrupt', 'muted:true']));
    f.hear('can it export to pdf?');
    await tick();
    expect(f.log.some((l) => l.startsWith('say:'))).toBe(false); // heard nothing worth saying aloud while muted
    s.unmute();
    expect(s.state).toBe('listening');
  });

  it('stops after the idle timeout and at the session cap, and on errors', async () => {
    const a = setup(); const fa = fakeProvider();
    const sa = await startLive(a.e, fa.p, { timers: a.timers, idleMs: 1000, maxMs: 10_000 });
    await a.timers.advance(1000);
    expect(sa.state).toBe('stopped');
    expect(fa.log).toContain('stop');

    const b = setup(); const fb = fakeProvider();
    const sb = await startLive(b.e, fb.p, { timers: b.timers, idleMs: 100_000, maxMs: 5000 });
    fb.hear('can it export to pdf?');
    await b.timers.advance(5000);
    expect(sb.state).toBe('stopped');

    const c = setup(); const fc = fakeProvider(); const onError = vi.fn();
    const sc = await startLive(c.e, fc.p, { timers: c.timers, onError });
    fc.fail(new Error('mic denied'));
    expect(sc.state).toBe('stopped');
    expect(onError).toHaveBeenCalled();
  });

  it('can announce something unprompted, unless muted or stopped', async () => {
    const { e, timers } = setup();
    const f = fakeProvider();
    const s = await startLive(e, f.p, { timers });
    s.say('Your agent wired search.');
    expect(f.log).toContain('say:Your agent wired search.');
    s.mute();
    s.say('Another one.');
    expect(f.log).not.toContain('say:Another one.');
    s.unmute(); s.stop();
    s.say('After stop.');
    expect(f.log).not.toContain('say:After stop.');
  });

  it('says nothing after it has stopped', async () => {
    const { e, timers } = setup();
    const f = fakeProvider();
    const s = await startLive(e, f.p, { timers });
    s.stop();
    f.hear('can it export to pdf?');
    await tick();
    expect(f.log.filter((l) => l.startsWith('say:'))).toEqual([]);
  });
});

describe('openaiRealtime', () => {
  function rig() {
    const sent: string[] = [];
    const dc = { send: (d: string) => sent.push(d), onmessage: null as ((e: { data: string }) => void) | null, onopen: null };
    const track = { enabled: true, stop: vi.fn() };
    const pc = {
      createDataChannel: vi.fn(() => dc),
      createOffer: vi.fn(async () => ({ sdp: 'OFFER' })),
      setLocalDescription: vi.fn(async () => {}),
      setRemoteDescription: vi.fn(async () => {}),
      addTrack: vi.fn(),
      ontrack: null as ((e: { streams: unknown[] }) => void) | null,
      close: vi.fn(),
    };
    const f = vi.fn(async () => new Response('ANSWER', { status: 200 }));
    const audio = { srcObject: null as unknown, autoplay: false };
    const p = openaiRealtime({
      getSecret: async () => ({ value: 'ek_short_lived', model: 'gpt-realtime' }),
      fetch: f as unknown as typeof fetch,
      createPeer: () => pc,
      getUserMedia: async () => ({ getTracks: () => [track] }),
      createAudio: () => audio,
    });
    return { p, pc, dc, track, f, sent, audio };
  }
  const handlers = () => ({ onTranscript: vi.fn(), onSpeechStart: vi.fn(), onError: vi.fn() });

  it('connects with the short-lived key (never the real one) and turns events into transcripts and barge-in', async () => {
    const r = rig();
    const h = handlers();
    await r.p.start(h);
    expect(r.f).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls?model=gpt-realtime', expect.objectContaining({
      method: 'POST', body: 'OFFER', headers: { authorization: 'Bearer ek_short_lived', 'content-type': 'application/sdp' },
    }));
    expect(r.pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'ANSWER' });
    r.dc.onmessage!({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'go to the map' }) });
    r.dc.onmessage!({ data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
    r.dc.onmessage!({ data: JSON.stringify({ type: 'error', error: { message: 'boom' } }) });
    r.dc.onmessage!({ data: 'not json' });
    expect(h.onTranscript).toHaveBeenCalledWith('go to the map');
    expect(h.onSpeechStart).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it('speaks exactly what it is given, interrupts, mutes the mic and shuts down', async () => {
    const r = rig();
    await r.p.start(handlers());
    r.p.say('Done: New note');
    expect(JSON.parse(r.sent[0]!)).toEqual({ type: 'response.create', response: { instructions: 'Say exactly the following words, and nothing else: Done: New note' } });
    r.p.interrupt();
    expect(r.sent.map((s) => JSON.parse(s).type)).toEqual(['response.create', 'response.cancel', 'output_audio_buffer.clear']);
    r.p.setMuted(true);
    expect(r.track.enabled).toBe(false);
    r.p.stop();
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.pc.close).toHaveBeenCalled();
  });

  it('reports a refused connection', async () => {
    const r = rig();
    const p = openaiRealtime({ getSecret: async () => ({ value: 'x' }), fetch: (async () => new Response('no', { status: 401 })) as never, createPeer: () => r.pc, getUserMedia: async () => ({ getTracks: () => [] }), createAudio: () => r.audio });
    await expect(p.start(handlers())).rejects.toThrow(/HTTP 401/);
  });
});

describe('browserLive', () => {
  it('keeps recognition open across the browser ending it, and mutes by stopping it', async () => {
    const recs: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onend: (() => void) | null; onresult: ((e: never) => void) | null; continuous: boolean }[] = [];
    class Rec { start = vi.fn(); stop = vi.fn(); onend: (() => void) | null = null; onresult: ((e: never) => void) | null = null; onerror = null; lang = ''; continuous = false; interimResults = true; constructor() { recs.push(this); } }
    const synth = { speak: vi.fn(), cancel: vi.fn() };
    const p = browserLive({ SpeechRecognition: Rec, speechSynthesis: synth, SpeechSynthesisUtterance: class { constructor(public text: string) {} lang = '' } });
    expect(p.supported).toBe(true);
    const onTranscript = vi.fn();
    await p.start({ onTranscript, onSpeechStart: vi.fn(), onError: vi.fn() });
    expect(recs[0]).toMatchObject({ continuous: true });
    recs[0]!.onresult!({ resultIndex: 0, results: [Object.assign([{ transcript: 'new note milk' }], { isFinal: true })] } as never);
    expect(onTranscript).toHaveBeenCalledWith('new note milk');
    recs[0]!.onend!(); // the browser closed it on silence
    expect(recs).toHaveLength(2);
    p.setMuted(true);
    expect(recs[1]!.stop).toHaveBeenCalled();
    p.say('hello');
    expect(synth.speak).toHaveBeenCalled();
    p.stop();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it('says plainly when the browser cannot do it', async () => {
    const p = browserLive({});
    expect(p.supported).toBe(false);
    await expect(p.start({ onTranscript() {}, onSpeechStart() {}, onError() {} })).rejects.toThrow(/not available/);
  });
});
