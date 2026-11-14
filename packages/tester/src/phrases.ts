/**
 * Phrase checks: does the Entoli layer understand what it should, and do what it should?
 *
 * For every act that is connected (not "off"), type its first phrase into the
 * app's real Entoli bar and look at the card:
 *
 *   ok               the right act's card appeared (asking for a missing value, holding,
 *                    waiting for a yes, or refusing a typed voice-only act: all "understood")
 *   ran              a held (self + undo) act ran and finished, then was undone
 *   not-understood   no card for it: the bar did not recognise the phrase
 *   wrong-act        a card for a different act
 *   failed           it ran and reported an error
 *   skipped          the page has no Entoli bar (or the act is not on a page we can open)
 *
 * Acts that need a yes are never confirmed: only the safe, reversible ones run.
 */
import { actLayer, type Skill, type SkillAct } from '@entoli/sdk/skill';
import type { BrowserLike } from './index.js';

export type PhraseStatus = 'ok' | 'ran' | 'not-understood' | 'wrong-act' | 'failed' | 'skipped';
export type PhraseResult = { act: string; title: string; phrase: string; status: PhraseStatus; phase?: string; got?: string; reason?: string };

type One = { waitFor(o: { state: 'attached' | 'visible'; timeout: number }): Promise<void>; fill(v: string): Promise<void>; press(k: string): Promise<void>; click(o?: { timeout?: number }): Promise<void>; getAttribute(n: string): Promise<string | null>; textContent(): Promise<string | null>; count(): Promise<number> };
type Locator = One & { first(): One };
export type PhrasePage = {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<{ status(): number } | null>;
  locator(selector: string): Locator;
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};
export type PhraseBrowser = { newPage(): Promise<unknown>; close(): Promise<void> };

function screenPath(skill: Skill, act: SkillAct): string {
  const node = skill.map.find((n) => n.kind === 'screen' && n.id === act.screen);
  const p = node?.path;
  return p && !p.includes(':') && !p.includes('*') ? p : '/';
}

function humanize(name: string): string {
  const s = name.replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function checkPhrases(skill: Skill, baseUrl: string, browser: BrowserLike, opts: { timeoutMs?: number; run?: boolean; log?: (l: string) => void } = {}): Promise<PhraseResult[]> {
  const base = baseUrl.replace(/\/$/, '');
  const wait = opts.timeoutMs ?? 4000;
  const results: PhraseResult[] = [];
  for (const act of skill.acts) {
    if (actLayer(skill, act) === 'off') continue;
    const title = act.title ?? humanize(act.name);
    const phrase = act.phrases[0]!;
    const r: PhraseResult = { act: act.name, title, phrase, status: 'skipped' };
    results.push(r);
    const page = (await browser.newPage()) as unknown as PhrasePage;
    try {
      await page.goto(`${base}${screenPath(skill, act)}`, { waitUntil: 'load', timeout: 15_000 });
      const input = page.locator('.entoli-input').first();
      try { await input.waitFor({ state: 'attached', timeout: 3000 }); }
      catch { r.reason = 'no Entoli bar on this page'; continue; }
      await input.fill(phrase);
      await input.press('Enter');
      const card = page.locator('.entoli-card').first();
      try { await card.waitFor({ state: 'attached', timeout: wait }); }
      catch { r.status = 'not-understood'; r.reason = 'nothing appeared'; continue; }
      const phase = (await card.getAttribute('data-phase')) ?? '';
      const got = ((await page.locator('.entoli-card .entoli-title').first().textContent().catch(() => null)) ?? '').trim();
      r.phase = phase; if (got) r.got = got;

      if (phase === 'none') { r.status = 'not-understood'; r.reason = 'the bar answered "I can\'t do that here"'; }
      else if (phase === 'answer') { r.status = 'wrong-act'; r.reason = 'the phrase was taken as a question about the app'; }
      else if (phase === 'error' && !got) { r.status = 'failed'; r.reason = 'the bar reported an error'; }
      else if (got && got !== title && phase !== 'narrow') { r.status = 'wrong-act'; r.reason = `understood as "${got}"`; }
      else if (phase === 'narrow') { r.status = 'ok'; r.reason = 'ambiguous with another act (it asked which one)'; }
      else if (phase === 'hold' && opts.run !== false) {
        // A held act is self + undo: let it run, check it finished, then undo it.
        const done = page.locator('.entoli-card[data-phase="done"], .entoli-card[data-phase="error"]').first();
        try { await done.waitFor({ state: 'attached', timeout: 4500 }); } catch { /* fall through to read the phase */ }
        const after = (await card.getAttribute('data-phase').catch(() => null)) ?? '';
        if (after === 'error') { r.status = 'failed'; r.reason = ((await page.locator('.entoli-card .entoli-msg').first().textContent().catch(() => '')) ?? '').slice(0, 200); }
        else if (after === 'done') {
          r.status = 'ran';
          const undo = page.locator('.entoli-receipts button').first();
          if ((await undo.count()) > 0) await undo.click({ timeout: 2000 }).catch(() => {});
        } else { r.status = 'failed'; r.reason = 'the held action never finished'; }
      } else {
        r.status = 'ok';
        // Never confirm anything that needs a yes: cancel the card.
        const no = page.locator('.entoli-card button:has-text("Not that")');
        if ((await no.count()) > 0) await no.first().click({ timeout: 2000 }).catch(() => {});
      }
    } catch (e) {
      r.status = 'failed';
      r.reason = (e as Error).message.split('\n')[0] ?? 'error';
    } finally {
      opts.log?.(`${r.status === 'ok' || r.status === 'ran' ? '✓' : r.status === 'skipped' ? '·' : '✗'} “${phrase}” → ${act.name}${r.reason ? ` (${r.reason})` : ''}`);
      await page.close().catch(() => {});
    }
  }
  return results;
}

export function summarizePhrases(results: PhraseResult[]) {
  const counted = results.filter((r) => r.status !== 'skipped');
  const good = counted.filter((r) => r.status === 'ok' || r.status === 'ran');
  return { checked: counted.length, good: good.length, percent: counted.length ? Math.round((good.length / counted.length) * 100) : 0, problems: counted.filter((r) => r.status !== 'ok' && r.status !== 'ran'), skipped: results.length - counted.length };
}
