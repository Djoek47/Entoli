import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Skill } from '@entoli/sdk/skill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openBrowser, walkMap, type BrowserLike } from '../src/index.js';

function serve(handler: (path: string) => { status: number; body: string; type?: string }): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const r = handler((req.url ?? '/').split('?')[0]!);
      res.writeHead(r.status, { 'content-type': r.type ?? 'text/html' });
      res.end(r.body);
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, server });
    });
  });
}

let browser: BrowserLike;
const servers: Server[] = [];
beforeAll(async () => {
  // This sandbox ships one Chromium build; use it whatever Playwright version pnpm installed.
  if (!process.env.ENTOLI_CHROMIUM_PATH && existsSync('/opt/pw-browsers/chromium')) process.env.ENTOLI_CHROMIUM_PATH = '/opt/pw-browsers/chromium';
  browser = await openBrowser();
});
afterAll(async () => { await browser?.close(); servers.forEach((s) => s.close()); });

describe('walkMap', () => {
  it('opens screens, finds selectors, and reports coverage and broken paths', async () => {
    const pages: Record<string, string> = {
      '/': '<button data-testid="new">New</button><a href="/settings">Settings</a>',
      '/settings': '<select name="theme"></select>',
      '/crash': '<script>throw new Error("boom")</script>',
    };
    const { url, server } = await serve((p) => (pages[p] ? { status: 200, body: pages[p]! } : { status: 404, body: 'nope' }));
    servers.push(server);
    const skill = {
      entoli: '0.1', app: { name: 'T' }, layer: 'L1', mode: 'text', knowledge: [], acts: [],
      map: [
        { id: 'home', kind: 'screen', title: 'Home', path: '/' },
        { id: 'home.new', kind: 'button', title: 'New', parent: 'home', selector: '[data-testid="new"]' },
        { id: 'home.gone', kind: 'button', title: 'Export', parent: 'home', selector: 'role=button[name="Export"]' },
        { id: 'settings', kind: 'screen', title: 'Settings', path: '/settings' },
        { id: 'settings.theme', kind: 'setting', title: 'Theme', parent: 'settings', selector: '[name="theme"]' },
        { id: 'missing', kind: 'screen', title: 'Missing', path: '/missing' },
        { id: 'missing.x', kind: 'button', title: 'X', parent: 'missing', selector: 'button' },
        { id: 'crash', kind: 'screen', title: 'Crash', path: '/crash' },
        { id: 'note', kind: 'screen', title: 'Note', path: '/notes/:id' },
        { id: 'nosel', kind: 'button', title: 'Mystery', parent: 'home' },
        { id: 'shared', kind: 'menu', title: 'Shared' },
        { id: 'shared.link', kind: 'link', title: 'Settings link', parent: 'shared', selector: 'a[href="/settings"]' },
      ],
    } as unknown as Skill;
    const r = await walkMap(skill, url, browser, { selectorTimeoutMs: 500 });
    const by = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(by.home!.status).toBe('ok');
    expect(by['home.new']!.status).toBe('ok');
    expect(by['home.gone']).toMatchObject({ status: 'broken', reason: expect.stringContaining('not found on /') });
    expect(by['settings.theme']!.status).toBe('ok');
    expect(by.missing).toMatchObject({ status: 'broken', reason: 'HTTP 404' });
    expect(by['missing.x']).toMatchObject({ status: 'broken', reason: 'screen /missing did not load' });
    expect(by.crash).toMatchObject({ status: 'broken', reason: 'page error: boom' });
    expect(by.note).toMatchObject({ status: 'unchecked', reason: 'route parameters' });
    expect(by.nosel).toMatchObject({ status: 'unchecked', reason: 'no selector' });
    expect(by['shared.link']!.status).toBe('ok'); // shared nodes are checked on the first screen
    expect(r.checked).toBe(9);
    expect(r.verified).toBe(5);
    expect(r.coverage).toBe(56);
  });
});

describe('the Fieldnotes example, walked against its own skill', () => {
  it('verifies every checkable node', async () => {
    const app = fileURLToPath(new URL('../../../examples/notes-app', import.meta.url));
    execSync('npx vite build --logLevel error', { cwd: app, stdio: 'ignore' });
    const dist = join(app, 'dist');
    const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    const { url, server } = await serve((p) => {
      const file = join(dist, p);
      if (p !== '/' && existsSync(file) && extname(file)) return { status: 200, body: readFileSync(file, 'utf8'), type: types[extname(file)] ?? 'text/plain' };
      return { status: 200, body: readFileSync(join(dist, 'index.html'), 'utf8') }; // SPA fallback
    });
    servers.push(server);
    const skill = JSON.parse(readFileSync(join(app, 'entoli.skill.json'), 'utf8')) as Skill;
    const r = await walkMap(skill, url, browser);
    expect(r.broken).toEqual([]);
    expect(r.coverage).toBe(100);
    expect(r.checked).toBeGreaterThanOrEqual(9);
  });
});
