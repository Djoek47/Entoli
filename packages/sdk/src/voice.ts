/**
 * Voice. v0.1 uses the browser's Web Speech API. The interface is small on
 * purpose so a paid STT/TTS provider can be swapped in without touching the
 * Stage or the runtime.
 */

export interface SpeechProvider {
  readonly name: string;
  readonly supported: boolean;
  /** Listen once. Resolves with the final transcript, or '' if nothing was heard. */
  listen(opts?: { lang?: string; onPartial?: (text: string) => void }): Promise<string>;
  stop(): void;
  speak?(text: string, opts?: { lang?: string }): void;
}

type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

export function webSpeech(win: unknown = typeof window !== 'undefined' ? window : undefined): SpeechProvider {
  const w = win as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike; speechSynthesis?: { speak(u: unknown): void; cancel(): void }; SpeechSynthesisUtterance?: new (t: string) => { lang: string } } | undefined;
  const Ctor = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
  let current: RecognitionLike | null = null;

  return {
    name: 'web-speech',
    supported: !!Ctor,
    listen(opts = {}) {
      if (!Ctor) return Promise.reject(new Error('Speech recognition is not available in this browser'));
      current?.stop();
      const rec = new Ctor();
      current = rec;
      rec.lang = opts.lang ?? 'en-US';
      rec.interimResults = !!opts.onPartial;
      rec.continuous = false;
      return new Promise<string>((resolve, reject) => {
        let final = '';
        rec.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]!;
            if (r.isFinal) final += r[0]!.transcript;
            else interim += r[0]!.transcript;
          }
          if (interim) opts.onPartial?.(final + interim);
        };
        rec.onerror = (e) => { if (e.error === 'no-speech' || e.error === 'aborted') resolve(''); else reject(new Error(e.error)); };
        rec.onend = () => { current = null; resolve(final.trim()); };
        rec.start();
      });
    },
    stop() {
      current?.stop();
    },
    speak(text, opts = {}) {
      if (!w?.speechSynthesis || !w.SpeechSynthesisUtterance) return;
      const u = new w.SpeechSynthesisUtterance(text);
      u.lang = opts.lang ?? 'en-US';
      w.speechSynthesis.cancel();
      w.speechSynthesis.speak(u);
    },
  };
}
