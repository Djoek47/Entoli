/**
 * The command bar and the Stage: one card at a time, in the Entoli brand.
 *
 * Structural rules (from tacit's eui stage):
 *   one card        render() replaces the card; nothing appends a second
 *   their words     what was said is drawn above the card, always
 *   a way out       "Not that" is on every card that could still run
 *   exact           every argument is listed, and the yes carries the
 *                   fingerprint of the card it was drawn on
 */

import type { Entoli, StageState } from './runtime.js';
import type { SpeechProvider } from './voice.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

export const CSS = `
.entoli{--e-ink:#0E0F0C;--e-paper:#FAFAF7;--e-lime:#A6E01C;--e-lime-text:#4F7A00;--e-line:rgba(14,15,12,.12);--e-muted:rgba(14,15,12,.6);--e-warn:#B42318;
font-family:'Hanken Grotesk',system-ui,sans-serif;color:var(--e-ink);font-size:15px;line-height:1.45;max-width:640px;width:100%;box-sizing:border-box}
.entoli *{box-sizing:border-box}
.entoli-bar{display:flex;align-items:center;gap:8px;background:var(--e-paper);border:1.5px solid var(--e-ink);border-radius:14px;padding:6px 6px 6px 14px}
.entoli-bar:focus-within{box-shadow:0 0 0 3px var(--e-lime)}
.entoli-mark{font-family:'JetBrains Mono',monospace;font-weight:500;display:inline-flex;align-items:center;gap:2px;user-select:none}
.entoli-wave{display:inline-flex;align-items:center;gap:2px;height:14px}
.entoli-wave i{display:block;width:3px;border-radius:2px;background:var(--e-lime);height:6px}
.entoli-wave i:nth-child(2){height:12px}.entoli-wave i:nth-child(3){height:9px}
.entoli.listening .entoli-wave i{animation:entoli-w .8s ease-in-out infinite alternate}
.entoli.listening .entoli-wave i:nth-child(2){animation-delay:.15s}.entoli.listening .entoli-wave i:nth-child(3){animation-delay:.3s}
@keyframes entoli-w{from{transform:scaleY(.4)}to{transform:scaleY(1.2)}}
.entoli-input{flex:1;min-width:0;border:0;background:transparent;font:inherit;color:inherit;padding:8px 4px;outline:none}
.entoli-btn{font:600 14px 'Hanken Grotesk',system-ui,sans-serif;border-radius:10px;border:1.5px solid var(--e-ink);background:var(--e-paper);color:var(--e-ink);padding:8px 14px;cursor:pointer;min-height:40px}
.entoli-btn:focus-visible{outline:3px solid var(--e-lime);outline-offset:2px}
.entoli-btn.primary{background:var(--e-ink);color:var(--e-paper)}
.entoli-btn.go{background:var(--e-lime);border-color:var(--e-ink)}
.entoli-btn.ghost{border-color:transparent;background:transparent;text-decoration:underline}
.entoli-mic{width:40px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.entoli-said{margin:12px 2px 6px;color:var(--e-muted);font-size:14px}
.entoli-said q{color:var(--e-ink);font-style:normal}
.entoli-card{background:var(--e-paper);border:1.5px solid var(--e-ink);border-radius:16px;padding:16px;position:relative;overflow:hidden}
.entoli-kicker{font:500 11px 'JetBrains Mono',monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--e-muted)}
.entoli-kicker b{color:var(--e-lime-text);font-weight:500}
.entoli-title{font:600 20px 'Sora',system-ui,sans-serif;margin:4px 0 8px;letter-spacing:-.01em}
.entoli-args{list-style:none;margin:8px 0;padding:0;border-top:1px solid var(--e-line)}
.entoli-args li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--e-line)}
.entoli-args span{color:var(--e-muted)}
.entoli-args code{font-family:'JetBrains Mono',monospace;font-size:13px;word-break:break-all;text-align:right}
.entoli-why{font-size:13px;color:var(--e-muted);margin:6px 0 0}
.entoli-msg{margin:4px 0}
.entoli-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.entoli-hold{position:absolute;left:0;bottom:0;height:4px;background:var(--e-lime);width:0}
.entoli-hold.run{transition-property:width;transition-timing-function:linear;width:100%}
.entoli-card.exact{border-width:2px;box-shadow:4px 4px 0 var(--e-ink)}
.entoli-card.blocked,.entoli-card.error{border-color:var(--e-warn)}
.entoli-receipts{list-style:none;margin:12px 0 0;padding:0;font-size:13px}
.entoli-receipts li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 2px;border-top:1px dashed var(--e-line)}
.entoli-receipts li.undone{color:var(--e-muted);text-decoration:line-through}
.entoli-receipts .entoli-btn{min-height:32px;padding:4px 10px;font-size:13px}
.entoli-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.entoli-hold.run{transition-duration:0s!important}.entoli.listening .entoli-wave i{animation:none}}
`;

export type StageOptions = {
  /** Inject the Sora / Hanken Grotesk / JetBrains Mono stylesheet. Default true. */
  fonts?: boolean;
  placeholder?: string;
  speech?: SpeechProvider;
  /** Read results aloud in voice mode. Default true. */
  speak?: boolean;
  document?: Document;
};

export type StageHandle = { destroy(): void; root: HTMLElement; listen(): Promise<void> };

function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(typeof k === 'string' ? doc.createTextNode(k) : k);
  return el;
}

function injectOnce(doc: Document, fonts: boolean): void {
  if (!doc.getElementById('entoli-css')) {
    const st = doc.createElement('style');
    st.id = 'entoli-css';
    st.textContent = CSS;
    doc.head.append(st);
  }
  if (fonts && !doc.getElementById('entoli-fonts')) {
    const l = doc.createElement('link');
    l.id = 'entoli-fonts';
    l.rel = 'stylesheet';
    l.href = FONTS;
    doc.head.append(l);
  }
}

const KICKER: Partial<Record<StageState['phase'], string>> = {
  hold: 'Doing this', confirm: 'Needs a yes', exact: 'Do exactly this', ask: 'One thing missing',
  narrow: 'Which one?', blocked: 'Not by typing', answer: 'From this app', none: 'Not here',
  running: 'Working', done: 'Done', error: 'Stopped', thinking: 'Reading',
};

export function renderStage(entoli: Entoli, el: HTMLElement, opts: StageOptions = {}): StageHandle {
  const doc = opts.document ?? el.ownerDocument;
  injectOnce(doc, opts.fonts ?? true);
  const voice = entoli.mode === 'voice' && !!opts.speech?.supported;

  const root = h(doc, 'div', { class: 'entoli', 'data-entoli': '' });
  const input = h(doc, 'input', { class: 'entoli-input', type: 'text', 'aria-label': 'Ask this app', placeholder: opts.placeholder ?? (voice ? 'Say or type what you want' : 'Type what you want'), autocomplete: 'off', enterkeyhint: 'go' });
  const mark = h(doc, 'span', { class: 'entoli-mark', 'aria-hidden': 'true' }, '>', h(doc, 'span', { class: 'entoli-wave' }, h(doc, 'i'), h(doc, 'i'), h(doc, 'i')));
  const mic = voice ? h(doc, 'button', { class: 'entoli-btn entoli-mic', type: 'button', 'aria-label': 'Speak' }, '🎙') : null;
  const go = h(doc, 'button', { class: 'entoli-btn primary', type: 'submit' }, 'Go');
  const form = h(doc, 'form', { class: 'entoli-bar', role: 'search' }, mark, input, mic, go);
  const stage = h(doc, 'div', { class: 'entoli-stage', 'aria-live': 'polite' });
  const receipts = h(doc, 'ul', { class: 'entoli-receipts', 'aria-label': 'Recent actions' });
  root.append(form, stage, receipts);
  el.append(root);

  let lastSpoken = '';

  const submit = (text: string, channel: 'text' | 'voice') => {
    void entoli.hear(text, { channel });
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    submit(t, 'text');
  });

  const listen = async () => {
    if (!opts.speech?.supported) return;
    root.classList.add('listening');
    try {
      const said = await opts.speech.listen({ onPartial: (p) => { input.value = p; } });
      input.value = '';
      if (said) submit(said, 'voice');
    } catch (e) {
      stage.replaceChildren(h(doc, 'p', { class: 'entoli-msg' }, `Microphone: ${(e as Error).message}`));
    } finally {
      root.classList.remove('listening');
    }
  };
  mic?.addEventListener('click', () => void listen());

  const btn = (label: string, cls: string, fn: () => void, attrs: Record<string, string> = {}) => {
    const b = h(doc, 'button', { class: `entoli-btn ${cls}`, type: 'button', ...attrs }, label);
    b.addEventListener('click', fn);
    return b;
  };

  const render = (s: StageState) => {
    // Receipts.
    receipts.replaceChildren(...s.receipts.slice(0, 5).map((r) =>
      h(doc, 'li', { class: r.undone ? 'undone' : '' }, h(doc, 'span', {}, r.summary),
        r.undoable && !r.undone ? btn('Undo', '', () => void entoli.undo(r.id), { 'aria-label': `Undo ${r.summary}` }) : null)));

    if (s.phase === 'idle' && !s.message) { stage.replaceChildren(); return; }

    const said = s.said ? h(doc, 'p', { class: 'entoli-said' }, 'You: ', h(doc, 'q', {}, s.said)) : null;
    const card = h(doc, 'div', { class: `entoli-card ${s.phase}`, 'data-phase': s.phase });
    const kicker = h(doc, 'div', { class: 'entoli-kicker' }, KICKER[s.phase] ?? '', s.via === 'model' ? h(doc, 'b', {}, ' · read by AI') : null);
    card.append(kicker);
    if (s.title && s.phase !== 'answer' && s.phase !== 'none') card.append(h(doc, 'div', { class: 'entoli-title' }, s.title));
    if (s.args && s.args.length && ['hold', 'confirm', 'exact', 'ask', 'running', 'done'].includes(s.phase)) {
      card.append(h(doc, 'ul', { class: 'entoli-args' }, ...s.args.map((a) => h(doc, 'li', {}, h(doc, 'span', {}, a.label), h(doc, 'code', {}, a.display)))));
    }
    if (s.message) card.append(h(doc, 'p', { class: 'entoli-msg' }, s.message));
    if (s.why && s.phase !== 'blocked') card.append(h(doc, 'p', { class: 'entoli-why' }, s.why));

    const actions = h(doc, 'div', { class: 'entoli-actions' });
    switch (s.phase) {
      case 'hold': {
        actions.append(btn('Do it now', 'primary', () => void entoli.confirm()), btn('Not that', '', () => entoli.notThat()));
        const bar = h(doc, 'div', { class: 'entoli-hold', role: 'progressbar', 'aria-label': 'Running shortly' });
        card.append(bar);
        const left = Math.max(0, (s.holdEndsAt ?? 0) - Date.now());
        bar.style.transitionDuration = `${left || s.holdMs || 0}ms`;
        // Next frame, so the transition runs from 0.
        const raf = (doc.defaultView?.requestAnimationFrame ?? ((f: () => void) => setTimeout(f, 16))).bind(doc.defaultView);
        raf(() => bar.classList.add('run'));
        break;
      }
      case 'confirm':
        actions.append(btn('Yes, do it', 'primary', () => void entoli.confirm()), btn('Not that', '', () => entoli.notThat()));
        break;
      case 'exact': {
        const fp = s.fingerprint ?? '';
        actions.append(btn('Do exactly this', 'go', () => void entoli.confirm(fp), { 'data-fingerprint': fp }), btn('Not that', '', () => entoli.notThat()));
        break;
      }
      case 'ask':
        if (s.ask) {
          card.append(h(doc, 'p', { class: 'entoli-msg' }, s.ask.prompt));
          for (const o of s.ask.options ?? []) actions.append(btn(o, '', () => void entoli.hear(o, { channel: s.channel ?? 'text' })));
        }
        actions.append(btn('Not that', 'ghost', () => entoli.notThat()));
        input.focus();
        break;
      case 'narrow':
      case 'none':
        for (const c of s.choices ?? []) actions.append(btn(c.title, '', () => void entoli.choose(c.act)));
        actions.append(btn('Not that', 'ghost', () => entoli.notThat()));
        break;
      case 'thinking':
      case 'running':
        actions.append(btn('Not that', 'ghost', () => entoli.notThat()));
        break;
      default:
        actions.append(btn('Close', 'ghost', () => entoli.reset()));
    }
    card.append(actions);
    if (said) stage.replaceChildren(said, card);
    else stage.replaceChildren(card);

    if (voice && opts.speak !== false && s.channel === 'voice' && s.message && s.message !== lastSpoken && (s.phase === 'answer' || s.phase === 'done' || s.phase === 'blocked')) {
      lastSpoken = s.message;
      opts.speech?.speak?.(s.message);
    }
  };

  const off = entoli.subscribe(render);
  return {
    root,
    listen,
    destroy() {
      off();
      root.remove();
    },
  };
}
