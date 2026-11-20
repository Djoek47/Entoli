// Accessibility and mobile audit of the running app (axe-core in a real browser, phone and desktop widths).
//
//   pnpm --filter @entoli/web dev          # in one terminal (local, no keys needed)
//   pnpm --filter @entoli/web a11y         # BASE_URL=http://localhost:3000 by default
//
// Fails (exit 1) on any WCAG 2.1 A/AA or best-practice violation, or horizontal scrolling at 375 px.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const base = process.env.BASE_URL || 'http://localhost:3000';

const browser = await chromium.launch(process.env.ENTOLI_CHROMIUM_PATH ? { executablePath: process.env.ENTOLI_CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const setup = await (await browser.newContext()).newPage();
await setup.goto(`${base}/dashboard`);
await setup.fill('input[name=name]', 'A11y audit');
await setup.click('form[aria-label="New app"] button');
await setup.waitForURL(/\/dashboard\/apps\/.+\/map/);
const id = setup.url().match(/apps\/([^/]+)/)[1];

const tabs = ['map', 'project', 'analyze', 'knowledge', 'skill', 'keys', 'usage', 'billing', 'design', 'integrate', 'sandbox', 'test'];
const paths = ['/', '/pricing', '/docs', '/docs/voice', '/docs/skill', '/docs/safety', '/privacy', '/terms', '/dashboard', ...tabs.map((t) => `/dashboard/apps/${id}/${t}`)];
let problems = 0;
for (const [label, viewport] of [['phone', { width: 375, height: 800 }], ['desktop', { width: 1280, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport });
  for (const path of paths) {
    const page = await ctx.newPage();
    await page.goto(base + path, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(400);
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] })).violations.map((v) => `${v.impact} ${v.id}: ${v.nodes[0].target.join(' ')}`));
    const overflow = label === 'phone' ? await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) : 0;
    const shown = path.replace(id, ':id');
    for (const v of violations) { console.log(`✗ ${label} ${shown}  ${v}`); problems++; }
    if (overflow > 0) { console.log(`✗ ${label} ${shown}  scrolls sideways by ${overflow}px`); problems++; }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(problems ? `\n${problems} problem(s)` : `✓ ${paths.length} pages × 2 widths: no violations, no sideways scrolling`);
process.exit(problems ? 1 : 0);
