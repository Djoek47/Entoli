// Builds public/ from the canonical static site (site/index.html at the repo root):
//  - the page itself, unchanged except for the "Ask Entoli" bar, which is
//    handed to @entoli/sdk (the site eats its own cooking)
//  - the SDK browser bundle and the site's skill.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const root = join(web, '..', '..');
const sdk = join(root, 'packages', 'sdk');
const pub = join(web, 'public');
mkdirSync(pub, { recursive: true });

if (!process.env.ENTOLI_SKIP_SDK_BUILD || !existsSync(join(sdk, 'dist', 'entoli.min.js'))) {
  execSync('pnpm run build', { cwd: sdk, stdio: 'inherit' });
}
// The analyzer runs inside the API (M4); Next imports its built output.
const analyzer = join(root, 'packages', 'analyzer');
if (!process.env.ENTOLI_SKIP_SDK_BUILD || !existsSync(join(analyzer, 'dist', 'index.js'))) {
  execSync('pnpm run build', { cwd: analyzer, stdio: 'inherit' });
}
copyFileSync(join(sdk, 'dist', 'entoli.min.js'), join(pub, 'entoli.min.js'));
copyFileSync(join(web, 'site', 'site.skill.json'), join(pub, 'site.skill.json'));
copyFileSync(join(web, 'site', 'site-entoli.js'), join(pub, 'site-entoli.js'));

let html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
const must = (cond, what) => { if (!cond) throw new Error(`build-site: could not find ${what} in site/index.html`); };

// 1. The bar: keep the container and the suggestions, give the form to the SDK.
const formRe = /<form id="askf"[\s\S]*?<\/form>/;
must(formRe.test(html), 'the Ask form');
html = html.replace(formRe, '<div id="entoli-bar"></div>').replace('<div class="stage" id="stage" hidden></div>', '');

// 2. The hand-written intent matcher goes; the page's own functions are exposed to the SDK acts.
const start = html.indexOf('// ---------------------------------------------------------- Ask Entoli');
const end = html.indexOf('// Opens in a working state');
must(start > 0 && end > start, 'the Ask Entoli script block');
html = html.slice(0, start) + `function go(id) { var t = $(id); if (!t) return; t.scrollIntoView({ block: 'start' }); t.classList.add('flash'); setTimeout(function () { t.classList.remove('flash'); }, 1400); }
  var curTab = 'connect'; var _tab = tab; tab = function (n) { curTab = n; _tab(n); };
  window.__entoliSite = { go: go, analyze: analyze, walkAll: walkAll, tab: tab, setTheme: setTheme, currentTab: function () { return curTab; },
    resetMap: function () { visited = {}; selected = [APP]; renderMap(); } };
  ` + html.slice(end);

// 3. Load the SDK and the wiring; small layout glue for the fixed bar.
must(html.includes('</body>'), '</body>');
html = html.replace('</body>', `<style>.ask .entoli{margin:0 auto;max-width:720px;display:flex;flex-direction:column-reverse}.ask .entoli-bar{border-radius:999px;width:100%;max-width:none;margin:0}.ask .entoli-stage{max-height:55vh;overflow:auto}</style>
<script>window.__entoliConfig = ${JSON.stringify({ key: process.env.NEXT_PUBLIC_ENTOLI_SITE_KEY || undefined, endpoint: process.env.NEXT_PUBLIC_ENTOLI_ENDPOINT || undefined })};</script>
<script src="/entoli.min.js"></script>
<script src="/site-entoli.js"></script>
</body>`);

// 4. Sign-in links go to the real login.
writeFileSync(join(pub, 'site.html'), html);
console.log(`site: public/site.html (${(html.length / 1024).toFixed(0)} kB) + SDK bundle`);
